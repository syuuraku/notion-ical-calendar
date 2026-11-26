import type { Server } from "node:http";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { Config } from "./config.js";
import { CalendarFeed } from "./feed.js";

export class CalendarServer {
	private server: Server;
	private feeds: CalendarFeed[];
	private cacheTtl: number;
	private calendarToken: string | null;

	constructor(config: Config) {
		this.feeds = [
			new CalendarFeed(
				"calendar",
				"Notion Calendar",
				config.notionApiKey,
				config,
			),
		];
		if (config.wechat) {
			this.feeds.push(
				new CalendarFeed(
					"wechat",
					"公众号推送排期",
					config.notionApiKey,
					config.wechat,
				),
			);
		}
		this.cacheTtl = config.cacheTtl;
		this.calendarToken = config.calendarToken;
		this.server = createServer(this.handleRequest.bind(this));
	}

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		);
		const path = url.pathname;

		try {
			if (path === "/health") {
				this.handleHealth(res);
				return;
			}
			const requestedPath = Buffer.from(path);
			const feed = this.feeds.find((entry) => entry.matches(requestedPath));
			if (!feed) {
				this.handleNotFound(res);
				return;
			}
			await this.handleCalendar(req, res, feed);
		} catch (error) {
			this.handleError(res, error);
		}
	}

	private handleHealth(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("OK");
	}

	private async handleCalendar(
		req: IncomingMessage,
		res: ServerResponse,
		feed: CalendarFeed,
	): Promise<void> {
		const { data, etag, timestamp } = await feed.getCalendarData(
			this.cacheTtl * 1000,
		);

		const ifNoneMatch = req.headers["if-none-match"];
		if (ifNoneMatch === etag) {
			res.writeHead(304);
			res.end();
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": `attachment; filename="${feed.slug}.ics"`,
			"Cache-Control": `public, max-age=${this.cacheTtl}`,
			ETag: etag,
			"Last-Modified": new Date(timestamp).toUTCString(),
		});
		res.end(data);
	}

	private handleNotFound(res: ServerResponse): void {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not Found");
	}

	private handleError(res: ServerResponse, error: unknown): void {
		const message = error instanceof Error ? error.message : "Unknown error";
		console.error("Request error:", message);
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("Internal Server Error");
	}

	start(port: number): Promise<void> {
		return new Promise((resolve) => {
			this.server.listen(port, () => {
				console.log(`Server listening on port ${port}`);
				if (this.calendarToken) {
					console.log(
						`Calendar feed: http://localhost:${port}/calendar/${this.calendarToken}.ics`,
					);
				} else {
					console.log(`Calendar feed: http://localhost:${port}/calendar.ics`);
				}
				console.log(`Health check: http://localhost:${port}/health`);
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}
}
