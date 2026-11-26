import { createHash, timingSafeEqual } from "node:crypto";
import { calendarToString, generateCalendar } from "./calendar.js";
import type { FeedConfig } from "./config.js";
import { NotionCalendarClient } from "./notion.js";

interface CacheEntry {
	data: string;
	etag: string;
	timestamp: number;
}

export class CalendarFeed {
	private readonly client: NotionCalendarClient;
	private readonly path: Buffer;
	private cache: CacheEntry | null = null;
	private pending: Promise<CacheEntry> | null = null;

	constructor(
		readonly slug: string,
		private readonly name: string,
		notionApiKey: string,
		config: FeedConfig,
	) {
		this.client = new NotionCalendarClient(notionApiKey, config);
		const token = config.calendarToken;
		this.path = Buffer.from(token ? `/${slug}/${token}.ics` : `/${slug}.ics`);
	}

	matches(path: Buffer): boolean {
		return path.length === this.path.length && timingSafeEqual(path, this.path);
	}

	async getCalendarData(cacheTtlMs: number): Promise<CacheEntry> {
		if (this.cache && Date.now() - this.cache.timestamp < cacheTtlMs) {
			return this.cache;
		}
		this.pending ??= this.fetchAndCache().finally(() => {
			this.pending = null;
		});
		return this.pending;
	}

	private async fetchAndCache(): Promise<CacheEntry> {
		try {
			const events = await this.client.fetchEvents();
			const data = calendarToString(generateCalendar(events, this.name));
			this.cache = {
				data,
				etag: `"${createHash("sha1").update(data).digest("hex")}"`,
				timestamp: Date.now(),
			};
		} catch (error) {
			if (!this.cache) throw error;
			const message = error instanceof Error ? error.message : "Unknown error";
			console.warn(
				`[warn] ${this.slug} fetch failed, serving stale cache:`,
				message,
			);
		}
		return this.cache;
	}
}
