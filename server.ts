import * as fs from "node:fs";
import * as http from "node:http";

export const PORT = 3000;

type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
    | JsonPrimitive
    | JsonValue[]
    | { [key: string]: JsonValue };

type ApiError = {
    kind: "error";
    message: string;
};

let currentValue: JsonValue = null;

function sendJson<T>(
    res: http.ServerResponse,
    result: T,
    statusCode = 200,
): void {
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
    });

    res.end(JSON.stringify(result, null, 2));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let body = "";

        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();

            if (body.length > 1_000_000) {
                reject(new Error("Request body is too large."));
                req.destroy();
            }
        });

        req.on("end", () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Request body must contain valid JSON."));
            }
        });

        req.on("error", reject);
    });
}

function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return true;
    }

    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }

    if (typeof value === "object") {
        return Object.values(value).every(isJsonValue);
    }

    return false;
}

export function getValue(res: http.ServerResponse): void {
    sendJson(res, {
        value: currentValue,
    });
}

export async function setValue(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    try {
        const body = await readJsonBody(req);

        if (!isJsonValue(body)) {
            const error: ApiError = {
                kind: "error",
                message: "The submitted value is not JSON-compatible.",
            };

            sendJson(res, error, 400);
            return;
        }

        currentValue = body;

        sendJson(res, {
            value: currentValue,
        });
    } catch (error) {
        const result: ApiError = {
            kind: "error",
            message:
                error instanceof Error
                    ? error.message
                    : "Could not read the submitted value.",
        };

        sendJson(res, result, 400);
    }
}

export function serveIndex(res: http.ServerResponse): void {
    try {
        const html = fs.readFileSync("./index.html", "utf8");

        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
        });

        res.end(html);
    } catch {
        res.writeHead(500, {
            "Content-Type": "text/plain; charset=utf-8",
        });

        res.end("Could not load index.html");
    }
}

export function createServer(): http.Server {
    return http.createServer(async (req, res) => {
        const url = new URL(
            req.url ?? "/",
            `http://${req.headers.host ?? "localhost"}`,
        );

        if (req.method === "GET" && url.pathname === "/") {
            serveIndex(res);
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/value") {
            getValue(res);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/value") {
            await setValue(req, res);
            return;
        }

        sendJson(
            res,
            {
                kind: "error",
                message: "Route not found.",
            },
            404,
        );
    });
}

export function setCurrentValue(value: JsonValue): void {
    currentValue = value;
}
