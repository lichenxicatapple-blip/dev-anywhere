import { z } from "zod";

export const VoiceAsrAudioEncodingSchema = z.enum(["pcm_s16le", "mulaw"]);

export const VoiceAsrStartMessageSchema = z.object({
  type: z.literal("start"),
  sessionId: z.string().min(1),
  attemptId: z.string().min(1),
  sampleRate: z.number().int().positive(),
  encoding: VoiceAsrAudioEncodingSchema,
});

export const VoiceAsrStopMessageSchema = z.object({
  type: z.literal("stop"),
  attemptId: z.string().min(1),
});

export const VoiceAsrClientMessageSchema = z.discriminatedUnion("type", [
  VoiceAsrStartMessageSchema,
  VoiceAsrStopMessageSchema,
]);

export const VoiceAsrServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), attemptId: z.string().min(1) }),
  z.object({
    type: z.literal("audio_ack"),
    attemptId: z.string().min(1),
    encodedBytes: z.number().int().nonnegative(),
    pcmBytes: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("partial"), attemptId: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal("final"), attemptId: z.string().min(1), text: z.string() }),
  z.object({
    type: z.literal("closed"),
    attemptId: z.string().min(1),
    code: z.number().int().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    attemptId: z.string().min(1),
    error: z.string().optional(),
    errorCode: z.string().optional(),
  }),
]);

export type VoiceAsrAudioEncoding = z.infer<typeof VoiceAsrAudioEncodingSchema>;
export type VoiceAsrStartMessage = z.infer<typeof VoiceAsrStartMessageSchema>;
export type VoiceAsrStopMessage = z.infer<typeof VoiceAsrStopMessageSchema>;
export type VoiceAsrClientMessage = z.infer<typeof VoiceAsrClientMessageSchema>;
export type VoiceAsrServerMessage = z.infer<typeof VoiceAsrServerMessageSchema>;
