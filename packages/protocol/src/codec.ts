/**
 * Encode and decode one WebSocket frame (P-01). Browser-safe: protobuf-es only.
 */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { ClientMessageSchema, ServerMessageSchema } from './gen/atlas/client/v1/client_pb.js';
import type { ClientMessage, ServerMessage } from './gen/atlas/client/v1/client_pb.js';

/** A message, or the plain-object init shape accepted by `create()`. */
export type ServerMessageInit = MessageInitShape<typeof ServerMessageSchema>;
export type ClientMessageInit = MessageInitShape<typeof ClientMessageSchema>;

/** Bytes as received from a WebSocket (`binaryType = 'arraybuffer'`) or from Node. */
export type FrameBytes = Uint8Array | ArrayBuffer;

function asBytes(data: FrameBytes): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function encodeServer(msg: ServerMessage | ServerMessageInit): Uint8Array {
  return toBinary(ServerMessageSchema, create(ServerMessageSchema, msg));
}

export function decodeServer(data: FrameBytes): ServerMessage {
  return fromBinary(ServerMessageSchema, asBytes(data));
}

export function encodeClient(msg: ClientMessage | ClientMessageInit): Uint8Array {
  return toBinary(ClientMessageSchema, create(ClientMessageSchema, msg));
}

export function decodeClient(data: FrameBytes): ClientMessage {
  return fromBinary(ClientMessageSchema, asBytes(data));
}

/** The per-socket fields of a Snapshot that tie it back to the client's request. */
export interface SnapshotBinding {
  viewRef?: string;
  windowRef?: string;
}

/**
 * Adds the per-socket binding (viewRef, windowRef) to an already encoded
 * snapshot frame, without decoding or re-encoding it.
 *
 * Protobuf merges a message that appears twice, so appending an encoded
 * `ServerMessage { snapshot { viewRef, windowRef } }` to the owner's payload
 * yields a valid frame with every original field plus the binding. Fields left
 * empty are not written and so never overwrite the original.
 */
export function bindSnapshot(snapshotFrame: Uint8Array, binding: SnapshotBinding): Uint8Array {
  const suffix = toBinary(
    ServerMessageSchema,
    create(ServerMessageSchema, {
      body: {
        case: 'snapshot',
        value: { viewRef: binding.viewRef ?? '', windowRef: binding.windowRef ?? '' },
      },
    }),
  );
  const out = new Uint8Array(snapshotFrame.byteLength + suffix.byteLength);
  out.set(snapshotFrame, 0);
  out.set(suffix, snapshotFrame.byteLength);
  return out;
}
