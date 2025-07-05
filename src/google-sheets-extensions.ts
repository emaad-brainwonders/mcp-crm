export class GoogleSheetsService {
    // ...existing code...

    // Find a row by email and contact number
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

    // Update a row by row index
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

    // ...existing code...
}
