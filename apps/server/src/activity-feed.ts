import { config } from "./config.js";

interface GraphTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const encodeForm = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

const isLikelyAadObjectId = (value: string): boolean => UUID_RE.test(value.trim());

export class ActivityFeedClient {
  private token: { value: string; expiresAtMs: number } | null = null;
  private readonly enabled: boolean;

  constructor() {
    const required = [
      config.graphTenantId,
      config.graphClientId,
      config.graphClientSecret,
      config.teamsAppId
    ];
    const hasRequired = required.every((value) => typeof value === "string" && value.trim().length > 0);
    this.enabled = config.enableActivityFeedNotifications && hasRequired;

    if (config.enableActivityFeedNotifications && !hasRequired) {
      console.warn("activity_feed_disabled_missing_config");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async sendToUsers(userIds: string[], previewText: string, taskId?: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const token = await this.getToken();
    for (const userIdRaw of new Set(userIds)) {
      const userId = userIdRaw.trim();
      if (!isLikelyAadObjectId(userId)) {
        console.warn("activity_feed_skipped_non_aad_user", { userId });
        continue;
      }

      const payload = {
        topic: {
          source: "text",
          value: "Operation Hot Task",
          webUrl: this.buildTaskDeepLink(taskId)
        },
        activityType: "systemDefault",
        previewText: {
          content: previewText
        }
      };

      const response = await fetch(`${config.graphBaseUrl}/users/${encodeURIComponent(userId)}/teamwork/sendActivityNotification`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Activity feed send failed: ${response.status} ${text}`);
      }
    }
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAtMs - 60_000) {
      return this.token.value;
    }

    const tokenUrl = `https://login.microsoftonline.com/${config.graphTenantId}/oauth2/v2.0/token`;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: encodeForm({
        client_id: config.graphClientId ?? "",
        client_secret: config.graphClientSecret ?? "",
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials"
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to acquire Graph token: ${response.status} ${text}`);
    }

    const json = (await response.json()) as GraphTokenResponse;
    this.token = {
      value: json.access_token,
      expiresAtMs: Date.now() + json.expires_in * 1000
    };
    return this.token.value;
  }

  private buildTaskDeepLink(taskId?: string): string {
    const base = `https://teams.microsoft.com/l/entity/${config.teamsAppId}/loan-tasks-home`;
    if (!taskId) {
      return base;
    }
    const context = encodeURIComponent(JSON.stringify({ subEntityId: taskId, taskId }));
    return `${base}?context=${context}`;
  }
}
