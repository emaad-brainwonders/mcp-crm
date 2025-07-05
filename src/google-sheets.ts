/// <reference lib="webworker" />

export class GoogleSheetsService {
    private accessToken: string;
    private sheetId: string;
    private refreshToken: string;
    private clientId: string;
    private clientSecret: string;
    private tokenExpiry: number | null = null;

    constructor(accessToken: string, sheetId: string, refreshToken?: string, clientId?: string, clientSecret?: string) {
        this.accessToken = accessToken;
        this.sheetId = sheetId;
        this.refreshToken = refreshToken || '';
        this.clientId = clientId || '';
        this.clientSecret = clientSecret || '';
    }

    private async refreshAccessTokenIfNeeded(): Promise<void> {
        if (!this.refreshToken || !this.clientId || !this.clientSecret) return;
        if (this.tokenExpiry && Date.now() < this.tokenExpiry - 60000) {
            // Token is still valid (with 1 min buffer)
            return;
        }
        const url = 'https://oauth2.googleapis.com/token';
        const params = new URLSearchParams();
        params.append('client_id', this.clientId);
        params.append('client_secret', this.clientSecret);
        params.append('refresh_token', this.refreshToken);
        params.append('grant_type', 'refresh_token');

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to refresh access token: ${error}`);
        }
        const data = (await response.json()) as { access_token?: string; expires_in?: number };
        this.accessToken = data.access_token || this.accessToken;
        if (data.expires_in) {
            this.tokenExpiry = Date.now() + data.expires_in * 1000;
        }
    }

    async appendRow(values: string[]): Promise<void> {
        await this.refreshAccessTokenIfNeeded();
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/Sheet1:append?valueInputOption=USER_ENTERED`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                values: [values]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to append to Google Sheet: ${error}`);
        }
    }

    async ensureHeaders(): Promise<void> {
        await this.refreshAccessTokenIfNeeded();
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/Sheet1!A1:F1`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
            }
        });

        if (response.ok) {
            const data = await response.json() as { values?: string[][] };
            if (!data.values || data.values.length === 0) {
                // Add headers
                await this.appendRow([
                    'Timestamp',
                    'User Email', 
                    'Contact Number',
                    'User Message',
                    'Assistant Response',
                    'User ID'
                ]);
            }
        }
    }
}
