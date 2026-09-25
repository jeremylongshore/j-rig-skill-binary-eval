import { describe, expect, it } from "vitest";
import { request } from "node:http";
import { startReportServer, waitForReportServer } from "./report-server.js";

describe("local report server", () => {
  it("serves the report and deterministic health endpoint", async () => {
    const server = await startReportServer("<!doctype html><title>fixture</title>");
    try {
      const report = await fetch(server.url);
      expect(report.status).toBe(200);
      expect(report.headers.get("content-type")).toContain("text/html");
      expect(await report.text()).toContain("fixture");

      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: "ok",
        service: "j-rig-report",
        trust: "unsigned-local",
        audience: "loopback",
      });

      const missing = await fetch(new URL("/missing", server.url));
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("supports a configured port and rejects non-loopback binds", async () => {
    const server = await startReportServer("report", { port: 0, host: "127.0.0.1" });
    await server.close();
    await expect(startReportServer("report", { host: "0.0.0.0" })).rejects.toThrow(
      "refuses non-loopback host",
    );
    await expect(startReportServer("report", { port: 65_536 })).rejects.toThrow(
      "port must be an integer",
    );
  });

  it("closes cleanly when the operator sends SIGINT", async () => {
    const server = await startReportServer("report");
    const listeners = new Map<string, () => void>();
    const signals = {
      once(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.set(event, listener);
      },
      removeListener(event: "SIGINT" | "SIGTERM", _listener: () => void) {
        void _listener;
        listeners.delete(event);
      },
    };

    const stopped = waitForReportServer(server, signals);
    listeners.get("SIGINT")?.();
    await stopped;
    await expect(fetch(server.url)).rejects.toThrow();
  });

  it("rejects a foreign Host header so a DNS-rebinding page cannot read the report", async () => {
    const server = await startReportServer("<!doctype html><title>internal</title>");
    // fetch() forbids overriding Host, so speak HTTP directly.
    const get = (host: string | undefined, path = "/") =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            host: server.host,
            port: server.port,
            path,
            method: "GET",
            setHost: false,
            headers: host === undefined ? {} : { Host: host },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      for (const foreign of [`attacker.example:${server.port}`, "attacker.example"]) {
        const denied = await get(foreign);
        expect(denied.status).toBe(421);
        expect(denied.body).not.toContain("internal");
        expect((await get(foreign, "/healthz")).status).toBe(421);
      }
      // A request with no Host at all never reaches the handler: Node's HTTP/1.1
      // parser rejects it first. Still denied, one layer earlier.
      const hostless = await get(undefined);
      expect(hostless.status).toBe(400);
      expect(hostless.body).not.toContain("internal");
      for (const local of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, "[::1]"]) {
        const allowed = await get(local);
        expect(allowed.status).toBe(200);
        expect(allowed.body).toContain("internal");
      }
    } finally {
      await server.close();
    }
  });
});
