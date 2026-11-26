// Facebook Graph API calls made from the browser (Graph supports CORS).
export const FB_BASE = "https://graph.facebook.com/v19.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80006]);

export type FbPage = { id: string; name: string; fan_count?: number; access_token: string };

type GraphResponse<T> = {
  [key: string]: unknown;
  data?: T[];
  paging?: { next?: string | null; cursors?: { after?: string | null } };
  error?: { code?: number; is_transient?: boolean; message?: string };
};
type Conversation = {
  id?: string;
  participants?: { data?: { id?: string; name?: string }[] };
};

export async function graphFetch<T = Record<string, unknown>>(
  url: string,
  attempt = 0,
): Promise<GraphResponse<T>> {
  let response: GraphResponse<T>;
  try {
    response = (await (await fetch(url)).json()) as GraphResponse<T>;
  } catch (error) {
    if (attempt < 4) return sleep(2000 * (attempt + 1)).then(() => graphFetch<T>(url, attempt + 1));
    throw error;
  }
  if (response.error) {
    if (
      (RATE_LIMIT_CODES.has(response.error.code ?? -1) || response.error.is_transient) &&
      attempt < 8
    ) {
      // App-level limits (#4/#17/#32) can last many minutes: back off up to ~1 min per retry.
      await sleep(Math.min(60000, 5000 * 2 ** attempt));
      return graphFetch<T>(url, attempt + 1);
    }
    throw new Error(response.error.message || "خطأ من فيسبوك");
  }
  return response;
}

export const withToken = (path: string, token: string) =>
  `${FB_BASE}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;

export async function getPages(userToken: string): Promise<FbPage[]> {
  const all: FbPage[] = [];
  let url: string | null = withToken(
    "/me/accounts?fields=name,id,fan_count,access_token&limit=100",
    userToken,
  );
  while (url) {
    const d: GraphResponse<FbPage> = await graphFetch<FbPage>(url);
    all.push(...(d.data ?? []));
    url = d.paging?.next ?? null;
  }
  return all;
}

export type ConvBatch = {
  data: Conversation[];
  after: string | null;
  next: string | null;
  done: boolean;
};

function toConversationBatch(response: GraphResponse<Conversation>): ConvBatch {
  const data = response.data ?? [];
  const next: string | null = response.paging?.next ?? null;
  return {
    data,
    after: response.paging?.cursors?.after ?? null,
    next,
    done: !next,
  };
}

/** One page of conversations. Only identity fields — message counts are irrelevant to the tool. */
export async function getConversationBatch(
  page: FbPage,
  after: string | null,
  fields = "id,participants",
): Promise<ConvBatch> {
  let path = `/${page.id}/conversations?platform=messenger&fields=${fields}&limit=500`;
  if (after) path += `&after=${encodeURIComponent(after)}`;
  return toConversationBatch(await graphFetch<Conversation>(withToken(path, page.access_token)));
}

async function getConversationBatchFromNext(
  page: FbPage,
  next: string,
  fields = "id",
): Promise<ConvBatch> {
  const url = new URL(next);
  const expectedPath = `/v19.0/${page.id}/conversations`;
  if (url.origin !== new URL(FB_BASE).origin || url.pathname !== expectedPath) {
    throw new Error("رابط ترقيم صفحات غير صالح من Facebook");
  }
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", "500");
  return toConversationBatch(await graphFetch<Conversation>(url.toString()));
}

/**
 * Real number of conversations: walks every page of ids (Facebook usually does not return a total
 * for this edge, so counting is the only reliable way).
 */
export async function countConversations(
  page: FbPage,
  onProgress: (n: number) => void | Promise<void>,
  shouldStop: () => boolean,
) {
  const ids = new Set<string>();
  let next: string | null = null;
  let firstBatch = true;
  let emptyRuns = 0;
  for (;;) {
    if (shouldStop()) return { count: ids.size, complete: false };
    const batch: ConvBatch = firstBatch
      ? await getConversationBatch(page, null, "id")
      : await getConversationBatchFromNext(page, next!, "id");
    firstBatch = false;
    batch.data.forEach((conversation) => conversation.id && ids.add(conversation.id));
    await onProgress(ids.size);
    emptyRuns = batch.data.length ? 0 : emptyRuns + 1;
    if (batch.done || emptyRuns >= 5) return { count: ids.size, complete: true };
    next = batch.next;
    await sleep(150);
  }
}

/** Facebook has no real creation date for pages; the oldest post is the closest estimate. */
export async function getOldestPostDate(page: FbPage, maxBatches = 25) {
  let url: string | null = withToken(
    `/${page.id}/posts?fields=created_time&limit=100`,
    page.access_token,
  );
  let last: string | null = null;
  let batches = 0;
  while (url) {
    const d: GraphResponse<{ created_time: string }> = await graphFetch<{ created_time: string }>(
      url,
    );
    const latestPost = d.data?.at(-1);
    if (latestPost) last = latestPost.created_time;
    url = d.paging?.next ?? null;
    if (++batches >= maxBatches) return { date: last, approx: !!url };
    await sleep(150);
  }
  return { date: last, approx: false };
}
