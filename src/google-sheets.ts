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
            // Log error details for debugging
            console.error('GoogleSheetsService.appendRow failed:', response.status, error);
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
            // Log error details for debugging
            console.error('GoogleSheetsService.updateRow failed:', response.status, error);
            throw new Error(`Failed to update Google Sheet: ${error}`);
        }
    }

    /**
     * Appends only new chat lines to the existing chat history cell.
     * @param email User email
     * @param contactNumber User contact number
     * @param newChatLines Array of new chat lines to append
     * @param otherValues Other columns (timestamp, summary, userId, etc)
     */
    async appendChatLinesToRow(email: string, contactNumber: string, newChatLines: string[], otherValues: string[]): Promise<void> {
        const found = await this.findRowByEmailAndContact(email, contactNumber);
        if (found) {
            // Only append new lines to the chat history cell (column 5, index 4)
            let prevHistory = found.values[4] || '';
            let mergedHistory = prevHistory;
            if (newChatLines.length > 0) {
                mergedHistory = prevHistory ? prevHistory + '\n' + newChatLines.join('\n') : newChatLines.join('\n');
            }
            // otherValues: [timestamp, summary, userId]
            await this.updateRow(found.rowIndex, [otherValues[0], email, contactNumber, otherValues[1], mergedHistory, otherValues[2]]);
        } else {
            // If not found, create new row with just the new chat lines
            await this.appendRow([
                otherValues[0],
                email,
                contactNumber,
                otherValues[1],
                newChatLines.join('\n'),
                otherValues[2]
            ]);
        }
    }
}
