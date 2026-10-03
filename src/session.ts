/**
 * One MCPL session per authenticated WebSocket connection. Handshake and
 * negotiated-policy handling follow heartbeat-mcpl (MCPL 0.5: the grant from a
 * Request-form featureSets/update is the only authority; until it arrives no
 * push goes out).
 *
 * Two feature sets, so a host that withholds pushEvents still keeps the tools:
 *   swarmbase         uses tools
 *   swarmbase.notify  uses pushEvents   (run-completion wakes)
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type { JsonRpcId, McplInitializeParams, PushEventParams } from '@animalabs/mcpl-core';
import type { WebSocket } from 'ws';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy,
} from './mcpl05.js';
import type {
  FeatureSetDeclaration05, FeatureSetMap, FeatureSetWireEntry, Grant,
  InitializeCapabilities05, McplInitializeResult05, McplServerCapabilities05,
} from './mcpl05.js';
import type { CallerPolicy } from './config.js';

export const FS_TOOLS = 'swarmbase';
export const FS_NOTIFY = 'swarmbase.notify';

const DECLS: FeatureSetMap = {
  [FS_TOOLS]: { description: 'Submit, inspect, cancel and resume orchestration scripts that fan out subagents', uses: ['tools'], rollback: false },
  [FS_NOTIFY]: { description: 'Run-completion notices (wake you when a run you submitted ends)', uses: ['pushEvents'], rollback: false },
} as Record<string, FeatureSetDeclaration05>;
const WIRE: FeatureSetWireEntry[] = Object.entries(DECLS).map(([name, d]) => ({ name, ...d }));

export interface ToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export interface ToolHost {
  toolDefinitions(): unknown[];
  callTool(caller: CallerPolicy, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface SessionEvents {
  ready(session: Session): void;
  closed(session: Session): void;
}

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown }
interface NotifMsg { method: string; params?: unknown }

export class Session {
  private conn: McplConnection;
  private mcplEnabled = false;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;
  private closed = false;

  constructor(
    readonly caller: CallerPolicy,
    ws: WebSocket,
    private readonly tools: ToolHost,
    private readonly events: SessionEvents,
    private readonly log: (line: string) => void,
  ) {
    this.conn = McplConnection.fromWebSocket(ws as never);
  }

  close(): void {
    this.closed = true;
    this.conn.close();
  }

  async serve(): Promise<void> {
    try {
      const first = await this.conn.nextMessage();
      if (first.type !== 'request' || first.request.method !== 'initialize') {
        this.log(`${this.caller.name}: expected initialize, got ${first.type}`);
        this.conn.close();
        return;
      }
      this.answerInitialize(first.request as ReqMsg);
      while (!this.conn.isClosed) {
        const msg = await this.conn.nextMessage();
        if (msg.type === 'request') void this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') this.log(`${this.caller.name}: connection error: ${(e as Error).message}`);
    } finally {
      this.closed = true;
      this.events.closed(this);
    }
  }

  private answerInitialize(req: ReqMsg): void {
    const params = req.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: McplServerCapabilities05 = { version: '0.5', pushEvents: true, featureSets: WIRE };
    const capabilities: InitializeCapabilities05 = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult05 = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'swarmbase', version: '0.1.0' },
    };
    this.conn.sendResponse(req.id, result);
    this.log(`${this.caller.name}: initialize answered (${this.mcplEnabled ? 'MCPL' : 'MCP-only; no completion pushes'})`);
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list':
          this.conn.sendResponse(req.id, { tools: this.tools.toolDefinitions() });
          break;
        case 'tools/call': {
          const blocked = this.toolsBlockedReason();
          if (blocked) { this.conn.sendError(req.id, -32001, `swarmbase tools unavailable: ${blocked}`); break; }
          const r = await this.tools.callTool(this.caller, String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
          this.conn.sendResponse(req.id, r);
          break;
        }
        case method.FEATURE_SETS_UPDATE:
          this.applyPolicyRequest(req);
          break;
        case 'ping':
          this.conn.sendResponse(req.id, {});
          break;
        default:
          this.conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      try { this.conn.sendError(req.id, -32000, (e as Error).message); } catch { /* closed */ }
    }
  }

  private handleNotification(n: NotifMsg): void {
    if (n.method === method.FEATURE_SETS_UPDATE) {
      const parsed = parsePolicy(n.params);
      if (parsed.ok) this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
    }
  }

  private applyPolicyRequest(req: ReqMsg): void {
    const parsed = parsePolicy(req.params);
    if (!parsed.ok) {
      this.grant = EMPTY_GRANT;
      this.policyReady = false;
      this.conn.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      return;
    }
    this.grant = parsed.grant;
    this.policyReady = true;
    this.conn.sendResponse(req.id, buildReceipt(DECLS, this.grant));
    this.log(`${this.caller.name}: policy applied grant=[${this.grant.patterns.join(', ')}] push=${this.pushBlockedReason() ?? 'ok'}`);
    this.events.ready(this); // every successful policy: a later grant of pushEvents must flush the outbox
  }

  /** Tools are allowed on MCP-only hosts and before policy (§3.2); once a 0.5
   *  policy is in force, a host that disabled the tools feature set is obeyed. */
  private toolsBlockedReason(): string | null {
    if (!this.mcplEnabled || !this.policyReady) return null;
    const st = deriveFeatureSetState(FS_TOOLS, DECLS[FS_TOOLS], this.grant);
    return st.active ? null : `feature set ${FS_TOOLS} ${st.reason}`;
  }

  pushBlockedReason(): string | null {
    if (this.closed) return 'session closed';
    if (!this.mcplEnabled) return 'host is MCP-only';
    if (!this.policyReady) return 'no featureSets/update Request yet';
    const st = deriveFeatureSetState(FS_NOTIFY, DECLS[FS_NOTIFY], this.grant);
    if (st.active) return null;
    return st.reason === 'capability_denied' ? `pushEvents not granted (${st.missing.join(', ')})` : `feature set ${FS_NOTIFY} ${st.reason}`;
  }

  /** Resolves true when the host accepted the event. */
  async push(eventId: string, text: string, origin: Record<string, unknown>): Promise<boolean> {
    const blocked = this.pushBlockedReason();
    if (blocked) { this.log(`${this.caller.name}: push ${eventId} held — ${blocked}`); return false; }
    const params: PushEventParams = {
      featureSet: FS_NOTIFY,
      eventId,
      timestamp: new Date().toISOString(),
      origin: { source: 'swarmbase', ...origin },
      payload: { content: [{ type: 'text', text }] },
    };
    try {
      const r = await this.conn.sendRequest(method.PUSH_EVENT, params, 30_000);
      const accepted = (r as { accepted?: unknown } | null)?.accepted;
      if (accepted === false) { this.log(`${this.caller.name}: push ${eventId} NOT accepted: ${JSON.stringify(r)}`); return false; }
      return true;
    } catch (e) {
      this.log(`${this.caller.name}: push ${eventId} failed: ${(e as Error).message}`);
      return false;
    }
  }
}
