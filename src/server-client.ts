// ServerClient — thin fetch wrapper around the Note Maintainer HTTP server.
// Owns the CSRF token and base URL; all review and command flows post here.

const CSRF_TOKEN_HEADER = "X-Note-Maintainer-Token";

export interface ReviewActionResult {
    ok: boolean;
    status: number;
    body: Record<string, unknown> | null;
}

export class ServerClient {
    private readonly baseUrl: string;
    private csrfToken = "";

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    setCsrfToken(token: string): void {
        this.csrfToken = token;
    }

    async get<T = any>(path: string): Promise<T> {
        const response = await fetch(this.baseUrl + path, {
            headers: this.authHeaders(),
        });
        return handleJsonResponse<T>(response, path);
    }

    async post<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
        const response = await fetch(this.baseUrl + path, {
            method: "POST",
            headers: {
                ...this.authHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        return handleJsonResponse<T>(response, path);
    }

    // Accept/reject return HTML unless the server is asked for JSON, and they
    // use 404/410 to signal expired or missing entries — so the status code
    // and optional JSON body are both surfaced to the caller.
    async postReviewAction(path: string): Promise<ReviewActionResult> {
        const response = await fetch(this.baseUrl + path, {
            method: "POST",
            headers: {
                ...this.authHeaders(),
                Accept: "application/json",
            },
        });
        const body = await response.json().catch(() => null);
        return { ok: response.ok, status: response.status, body };
    }

    private authHeaders(): Record<string, string> {
        return this.csrfToken ? { [CSRF_TOKEN_HEADER]: this.csrfToken } : {};
    }
}

async function handleJsonResponse<T>(response: Response, path: string): Promise<T> {
    if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        const message =
            (errBody as { error?: string } | null)?.error ??
            `HTTP ${response.status} for ${path}`;
        throw new Error(message);
    }
    return response.json();
}

let defaultClient: ServerClient | null = null;

export function setDefaultClient(client: ServerClient): void {
    defaultClient = client;
}

export function getDefaultClient(): ServerClient {
    if (!defaultClient) {
        throw new Error("ServerClient not initialized — call setDefaultClient from the plugin onload.");
    }
    return defaultClient;
}
