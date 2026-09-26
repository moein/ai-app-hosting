import PostalMime from 'postal-mime';

export type InboxMessage = {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  received_at: number;
};

export const MESSAGE_TTL_SECONDS = 86_400;

const keyPrefix = (to: string) => `msg:${to.toLowerCase()}:`;

/** Parses a raw RFC 822 message and stores it under the recipient (full address incl. `+tag`) for 24 h. */
export async function storeMessage(
  kv: KVNamespace,
  input: { to: string; from: string; raw: ReadableStream | ArrayBuffer | string; receivedAt: number },
): Promise<InboxMessage> {
  const parsed = await PostalMime.parse(input.raw);
  const message: InboxMessage = {
    id: crypto.randomUUID(),
    to: input.to.toLowerCase(),
    from: parsed.from?.address ?? input.from,
    subject: parsed.subject ?? '',
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    received_at: input.receivedAt,
  };
  const key = `${keyPrefix(message.to)}${String(message.received_at).padStart(15, '0')}:${message.id}`;
  await kv.put(key, JSON.stringify(message), { expirationTtl: MESSAGE_TTL_SECONDS });
  return message;
}

/** Messages for `to` received at or after `since`, newest first. */
export async function listMessages(kv: KVNamespace, to: string, since: number): Promise<InboxMessage[]> {
  const prefix = keyPrefix(to);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    for (const { name } of page.keys) {
      const receivedAt = Number(name.slice(prefix.length).split(':')[0]);
      if (receivedAt >= since) keys.push(name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  const messages = await Promise.all(keys.map((key) => kv.get<InboxMessage>(key, 'json')));
  return messages
    .filter((message): message is InboxMessage => message !== null)
    .sort((a, b) => b.received_at - a.received_at);
}
