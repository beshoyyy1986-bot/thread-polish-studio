import { afterEach, describe, expect, it, vi } from "vitest";
import { countConversations, getConversationBatch, type FbPage } from "@/lib/facebook";

const page: FbPage = { id: "PAGE", name: "Page", access_token: "token" };

afterEach(() => vi.unstubAllGlobals());

describe("Facebook conversation counting", () => {
  it("requests 500 conversations per Graph request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getConversationBatch(page, null, "id");

    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("limit")).toBe("500");
    expect(result.done).toBe(true);
  });

  it("stops after the current batch and returns the partial count", async () => {
    const data = Array.from({ length: 500 }, (_, i) => ({ id: `t_${i}` }));
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ data, paging: { next: "next", cursors: { after: "cursor" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let stop = false;
    const progress: number[] = [];

    const result = await countConversations(
      page,
      (n) => {
        progress.push(n);
        stop = true;
      },
      () => stop,
    );

    expect(result).toEqual({ count: 500, complete: false });
    expect(progress).toEqual([500]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
