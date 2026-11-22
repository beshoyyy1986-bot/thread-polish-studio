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

  it("follows Facebook's next URL until all batches have been counted", async () => {
    const firstBatch = Array.from({ length: 500 }, (_, i) => ({ id: `t_${i}` }));
    const next =
      "https://graph.facebook.com/v19.0/PAGE/conversations?after=cursor&access_token=token";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ data: firstBatch, paging: { next, cursors: { after: "cursor" } } }),
      })
      .mockResolvedValueOnce({ json: async () => ({ data: [{ id: "t_500" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];

    const result = await countConversations(
      page,
      (count) => void progress.push(count),
      () => false,
    );

    expect(result).toEqual({ count: 501, complete: true });
    expect(progress).toEqual([500, 501]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [request] of fetchMock.mock.calls) {
      expect(new URL(request as string).searchParams.get("limit")).toBe("500");
    }
  });

  it("stops after the current batch and returns the partial count", async () => {
    const data = Array.from({ length: 500 }, (_, i) => ({ id: `t_${i}` }));
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        data,
        paging: {
          next: "https://graph.facebook.com/v19.0/PAGE/conversations?after=cursor",
          cursors: { after: "cursor" },
        },
      }),
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
