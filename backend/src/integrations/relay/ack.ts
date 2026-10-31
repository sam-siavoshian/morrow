import type { RelayMessageView } from "@morrow/contracts";

/**
 * A replacement worker confirms a handoff by posting `ACK <leaseId>`. It counts only when the sender is the
 * lease's own agent name: any agent can post that text, but the engine stamps `from.name` from the
 * authenticated identity. The text must start with exactly `ACK` followed by the full lease id as its own token.
 */
export function isHandoffAck(message: Pick<RelayMessageView, "type" | "from" | "text">, lease: { leaseId: string; agentName: string }): boolean {
  if (message.type !== "message" || !lease.leaseId || !lease.agentName) return false;
  if (message.from.name !== lease.agentName) return false;
  const [verb, id] = message.text.trim().split(/\s+/, 2);
  return verb === "ACK" && id === lease.leaseId;
}
