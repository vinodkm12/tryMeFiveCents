import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";

export type URL = readonly string[];

export interface RetrieveError {
    readonly kind: "RetrieveError";
    readonly message: string;
    readonly status?: number;
}

export interface KalshiAuth {
    readonly keyName: string;
    readonly privateKey: string;
}

export interface BalanceResponse {
    readonly balance: number;
}

const BASE_URL = "https://api.elections.kalshi.com";
const KEY_NAME: string = "fff90ee6-f6e6-4acf-9a70-eea3bd94e2af";

export function loadKalshiAuth(privateKeyPath: string): KalshiAuth {
    const privateKey = fs.readFileSync(privateKeyPath, "utf8").trim();
    return { keyName: KEY_NAME, privateKey: privateKey };
}

export function signPssText(privateKey: string, text: string): string {
    return crypto.sign("sha256", Buffer.from(text), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString("base64");
}

function makeKalshiHeaders(auth: KalshcollectPaginatediAuth, method: "GET", path: string): HeadersInit {
    const timestamp = Date.now().toString();
    const signature = signPssText(auth.privateKey, timestamp + method + path);

    return {
        "KALSHI-ACCESS-KEY": auth.keyName,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        accept: "application/json",
    };
}

export async function callKalshiApi<T = string>(
    auth: KalshiAuth,
    endpoint: URL,
    keyRenameMap: Record<string, string> = {},
    params: Record<string, string> = {},
): Promise<T> {
    const method = "GET";
    const path = `/trade-api/v2/${endpoint.join("/")}`;
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) searchParams.set(key, String(value));
    }

    const query = searchParams.toString();
    const url = query === "" ? `${BASE_URL}${path}` : `${BASE_URL}${path}?${query}`;
    const response = await fetch(url, { method, headers: makeKalshiHeaders(auth, method, path) });

    if (!response.ok) throw new Error(`Bad Kalshi API response ${response.status}:\n${await response.text()}`);

    var json = await response.json();
    for (const key of Object.keys(keyRenameMap)) {
        json[keyRenameMap[key]] = json[key];
        delete json[key];
    }
    const result = json as T;
    return result;
}

export async function getBalance(auth: KalshiAuth): Promise<BalanceResponse | RetrieveError> {
    return callKalshiApi<BalanceResponse>(auth, ["portfolio", "balance"]);
}