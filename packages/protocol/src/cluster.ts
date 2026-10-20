/**
 * @atlas/protocol/cluster — worker <-> worker gRPC schema (contracts §4, P-01).
 *
 * A separate entry point so the browser bundle (`@atlas/protocol`) never pulls
 * in cluster types. This module itself is runtime-neutral (protobuf-es
 * descriptors only); the Node gRPC server and client are built in the
 * view-service with @connectrpc/connect-node (see README).
 */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { OwnerEventSchema, OwnerRequestSchema } from './gen/atlas/cluster/v1/view_owner_pb.js';
import type { OwnerEvent, OwnerRequest } from './gen/atlas/cluster/v1/view_owner_pb.js';

export * from './gen/atlas/cluster/v1/view_owner_pb.js';

export function encodeOwnerRequest(
  msg: OwnerRequest | MessageInitShape<typeof OwnerRequestSchema>,
): Uint8Array {
  return toBinary(OwnerRequestSchema, create(OwnerRequestSchema, msg));
}

export function decodeOwnerRequest(bytes: Uint8Array): OwnerRequest {
  return fromBinary(OwnerRequestSchema, bytes);
}

export function encodeOwnerEvent(
  msg: OwnerEvent | MessageInitShape<typeof OwnerEventSchema>,
): Uint8Array {
  return toBinary(OwnerEventSchema, create(OwnerEventSchema, msg));
}

export function decodeOwnerEvent(bytes: Uint8Array): OwnerEvent {
  return fromBinary(OwnerEventSchema, bytes);
}
