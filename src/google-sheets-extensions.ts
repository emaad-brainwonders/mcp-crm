export class GoogleSheetsService {
    private accessToken: string;
    private sheetId: string;

    constructor(accessToken: string, sheetId: string) {
        this.accessToken = accessToken;
        this.sheetId = sheetId;
    }

    async appendRow(values: string[]): Promise<void> {
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
        // Check if headers exist, if not add them
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

    async findRowByEmailAndContact(email: string, contactNumber: string): Promise<{ rowIndex: number, values: string[] } | null> {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/Sheet1!A2:F1000`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
            }
        });
        if (!response.ok) return null;
        const data = await response.json() as { values?: string[][] };
        if (!data.values) return null;
        for (let i = 0; i < data.values.length; i++) {
            const row = data.values[i];
            if (row[1] === email && row[2] === contactNumber) {
                return { rowIndex: i + 2, values: row }; // +2 because A2 is row 2
            }
        }
        return null;
    }

    async updateRow(rowIndex: number, values: string[]): Promise<void> {
        const range = `Sheet1!A${rowIndex}:F${rowIndex}`;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${range}?valueInputOption=USER_ENTERED`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ values: [values] })
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to update Google Sheet: ${error}`);
        }
    }
}
