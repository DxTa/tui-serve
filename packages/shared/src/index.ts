import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const sessionStatusSchema = z.enum(['starting', 'running', 'stopped', 'crashed', 'killed', 'unknown']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const restartPolicySchema = z.enum(['manual', 'on-crash']);
export type RestartPolicy = z.infer<typeof restartPolicySchema>;

export const errorCodeSchema = z.enum([
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_RUNNING',
  'SESSION_NOT_STOPPED',
  'INVALID_SESSION_ID',
  'INVALID_COMMAND_ID',
  'INVALID_CWD',
  'AUTH_REQUIRED',
  'ATTACH_FAILED',
  'KILL_CONFIRM_REQUIRED',
  'PROTOCOL_VERSION',
  'RATE_LIMITED',
  'RESUME_NOT_AVAILABLE',
  'CRASH_LOOP',
  'INTERNAL',
  'INVALID_INPUT',
]);
export type ErrorCodeValue = z.infer<typeof errorCodeSchema>;

export const createSessionRequestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  title: z.string().max(100).optional(),
  commandId: z.string().min(1),
  cwd: z.string().min(1),
  resumeFrom: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const updateSessionRequestSchema = z.object({
  title: z.string().max(100).optional(),
  restartPolicy: restartPolicySchema.optional(),
}).strict();
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const killSessionRequestSchema = z.object({
  confirm: z.boolean().optional(),
}).strict();
export type KillSessionRequest = z.infer<typeof killSessionRequestSchema>;

const envelopeSchema = z.object({
  v: z.number().int().positive().optional(),
  requestId: z.string().optional(),
});

export const participantCapabilitySchema = z.enum(['view', 'input', 'resize', 'kill', 'restart', 'edit_metadata']);
export type ParticipantCapability = z.infer<typeof participantCapabilitySchema>;

export const authMessageSchema = envelopeSchema.extend({
  type: z.literal('auth'),
  token: z.string(),
  clientId: z.string().min(1).optional(),
  clientName: z.string().min(1).optional(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  authMessageSchema,
  envelopeSchema.extend({ type: z.literal('ping') }),
  envelopeSchema.extend({ type: z.literal('subscribe_dashboard') }),
  envelopeSchema.extend({ type: z.literal('unsubscribe_dashboard') }),
  envelopeSchema.extend({ type: z.literal('subscribe_session'), sessionId: z.string().min(1) }),
  envelopeSchema.extend({ type: z.literal('unsubscribe_session'), sessionId: z.string().min(1) }),
  envelopeSchema.extend({
    type: z.literal('attach'),
    sessionId: z.string().min(1),
    requestedCapabilities: z.array(participantCapabilitySchema).optional(),
    mode: z.enum(['controller', 'viewer', 'auto']).optional(),
  }),
  envelopeSchema.extend({ type: z.literal('input'), sessionId: z.string().min(1), data: z.string() }),
  envelopeSchema.extend({ type: z.literal('resize'), sessionId: z.string().min(1), cols: z.number().int().min(1), rows: z.number().int().min(1) }),
  envelopeSchema.extend({ type: z.literal('detach'), sessionId: z.string().min(1) }),
  envelopeSchema.extend({ type: z.literal('kill'), sessionId: z.string().min(1), confirm: z.boolean() }),
  envelopeSchema.extend({ type: z.literal('restart'), sessionId: z.string().min(1) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('ping') }),
  envelopeSchema.extend({ type: z.literal('pong') }),
  envelopeSchema.extend({ type: z.literal('attached'), sessionId: z.string() }),
  envelopeSchema.extend({ type: z.literal('snapshot'), sessionId: z.string(), data: z.string() }),
  envelopeSchema.extend({ type: z.literal('status'), sessionId: z.string(), status: sessionStatusSchema, pid: z.number().nullable(), exitCode: z.number().nullable() }),
  envelopeSchema.extend({ type: z.literal('session_update'), sessionId: z.string() }).passthrough(),
  envelopeSchema.extend({ type: z.literal('dashboard_update'), changedSessionIds: z.array(z.string()).optional() }),
  envelopeSchema.extend({ type: z.literal('participant_update'), sessionId: z.string(), participants: z.array(z.object({
    id: z.string(),
    clientId: z.string().nullable(),
    capabilities: z.array(participantCapabilitySchema),
  })) }),
  envelopeSchema.extend({ type: z.literal('error'), code: errorCodeSchema, message: z.string() }),
  envelopeSchema.extend({ type: z.literal('kill_ack'), sessionId: z.string() }),
  envelopeSchema.extend({ type: z.literal('detach_ack'), sessionId: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
