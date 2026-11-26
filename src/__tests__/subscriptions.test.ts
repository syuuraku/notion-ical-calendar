import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { CalendarServer } from "../server.js";

function title(value: string) {
	return { type: "title", title: [{ plain_text: value }] };
}

function date(start: string, end?: string) {
	return { type: "date", date: { start, end } };
}

function page(id: string, properties: Record<string, unknown>) {
	return { object: "page", id, url: `https://notion.so/${id}`, properties };
}

const events = [
	page("meeting", { Event: title("Meeting"), Date: date("2026-11-20") }),
];
const articles = [
	page("article", {
		Title: title("Article"),
		Duration: date("2026-11-24T10:00:00+08:00", "2026-11-24T11:30:00+08:00"),
		"Published Date": date("2026-11-28"),
	}),
	page("undated", {
		Title: title("No duration"),
		Duration: { type: "date", date: null },
		"Received Date": date("2026-11-21"),
	}),
];

const retrieve = vi.fn(async ({ database_id }: { database_id: string }) => ({
	data_sources: [{ id: `source-${database_id}` }],
}));
const query = vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
	results: data_source_id === "source-articles" ? articles : events,
	has_more: false,
}));

vi.mock("@notionhq/client", () => ({
	Client: class {
		databases = { retrieve };
		dataSources = { query };
	},
}));

describe("Application Events and WeChat subscriptions", () => {
	let server: CalendarServer;
	let appUrl: string;
	let wechatUrl: string;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NOTION_API_KEY", "test-key");
		vi.stubEnv("NOTION_DATABASE_ID", "events");
		vi.stubEnv("CALENDAR_TOKEN", "app-token");
		vi.stubEnv("WECHAT_DATABASE_ID", "articles");
		vi.stubEnv("WECHAT_CALENDAR_TOKEN", "new-token");
		vi.stubEnv("WECHAT_DATE_PROPERTY", "");
		vi.stubEnv("WECHAT_PROPERTY_DATE", "");
		vi.stubEnv("WECHAT_PROPERTY_TITLE", "");
		vi.stubEnv("CACHE_TTL", "300");
	});

	async function startServer(wechatToken = "new-token") {
		server = new CalendarServer(loadConfig());
		await server.start(0);
		const { port } = (
			server as unknown as { server: Server }
		).server.address() as AddressInfo;
		appUrl = `http://localhost:${port}/calendar/app-token.ics`;
		wechatUrl = `http://localhost:${port}/wechat/${wechatToken}.ics`;
	}

	afterEach(async () => {
		await server.stop();
		vi.unstubAllEnvs();
	});

	it("queries each database by its own date and caches its own calendar", async () => {
		await startServer();
		const [app, wechat] = await Promise.all([fetch(appUrl), fetch(wechatUrl)]);
		expect(app.status).toBe(200);
		expect(wechat.status).toBe(200);
		const appBody = await app.text();
		const wechatBody = await wechat.text();
		expect(appBody).toContain("SUMMARY:Meeting");
		expect(appBody).not.toContain("SUMMARY:Article");
		expect(wechatBody).toContain("SUMMARY:Article");
		expect(wechatBody).toContain("DTSTART:20261124T020000Z");
		expect(wechatBody).toContain("DTEND:20261124T033000Z");
		expect(wechatBody).not.toContain("SUMMARY:No duration");
		expect(wechatBody).not.toContain("SUMMARY:Meeting");
		for (const [source, property] of [
			["events", "Date"],
			["articles", "Duration"],
		]) {
			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					data_source_id: `source-${source}`,
					filter: { property, date: { is_not_empty: true } },
				}),
			);
		}
		const appTag = app.headers.get("etag") ?? "";
		const wechatTag = wechat.headers.get("etag") ?? "";
		expect(wechatTag).not.toBe(appTag);
		const cached = await fetch(wechatUrl, {
			headers: { "If-None-Match": appTag },
		});
		expect(cached.status).toBe(200);
		expect(await cached.text()).toBe(wechatBody);
		const unchanged = await fetch(wechatUrl, {
			headers: { "If-None-Match": wechatTag },
		});
		expect(unchanged.status).toBe(304);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("rejects swapped tokens and a bare WeChat URL before reading Notion", async () => {
		await startServer();
		for (const url of [
			appUrl.replace("app-token", "new-token"),
			wechatUrl.replace("new-token", "app-token"),
			wechatUrl.replace("/new-token", ""),
		]) {
			expect((await fetch(url)).status).toBe(404);
		}
		expect(retrieve).not.toHaveBeenCalled();
	});

	it("retries a failed WeChat request without serving the Application cache", async () => {
		await startServer();
		expect((await fetch(appUrl)).status).toBe(200);
		query.mockRejectedValueOnce(new Error("WeChat database unavailable"));
		expect((await fetch(wechatUrl)).status).toBe(500);
		expect(await (await fetch(wechatUrl)).text()).toContain("SUMMARY:Article");
		expect(await (await fetch(appUrl)).text()).toContain("SUMMARY:Meeting");
		expect(query).toHaveBeenCalledTimes(3);
	});

	it("serves distinct calendars with the same token and custom WeChat columns", async () => {
		vi.stubEnv("WECHAT_CALENDAR_TOKEN", "");
		vi.stubEnv("WECHAT_PROPERTY_TITLE", "稿件名称");
		vi.stubEnv("WECHAT_PROPERTY_DATE", "工作时段");
		await startServer("app-token");
		query.mockResolvedValueOnce({
			results: [
				page("custom", {
					稿件名称: title("Edited article"),
					工作时段: date("2026-12-05"),
				}),
			],
			has_more: false,
		});
		const wechat = await fetch(wechatUrl);
		expect(wechat.status).toBe(200);
		const wechatBody = await wechat.text();
		expect(wechatBody).toContain("SUMMARY:Edited article");
		expect(wechatBody).toContain("DTSTART;VALUE=DATE:20261205");
		expect(query).toHaveBeenCalledWith(
			expect.objectContaining({
				data_source_id: "source-articles",
				filter: { property: "工作时段", date: { is_not_empty: true } },
			}),
		);
		const app = await fetch(appUrl);
		expect(app.status).toBe(200);
		const appBody = await app.text();
		expect(appBody).toContain("SUMMARY:Meeting");
		expect(appBody).not.toContain("Edited article");
	});
});
