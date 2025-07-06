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
            console.error('Google Sheets API Error:', error);
            throw new Error(`Failed to append to Google Sheet: ${response.status} ${response.statusText}`);
        }
    }

    async getRows(range: string = 'Sheet1!A1:Z1000'): Promise<string[][]> {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${range}`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
            }
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('Google Sheets API Error:', error);
            throw new Error(`Failed to read from Google Sheet: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { values?: string[][] };
        return data.values || [];
    }

    async ensureHeaders(): Promise<void> {
        try {
            const rows = await this.getRows('Sheet1!A1:F1');
            
            if (rows.length === 0) {
                // Add headers if sheet is empty
                await this.appendRow([
                    'Timestamp',
                    'User Email',
                    'Contact Number',
                    'Message Count',
                    'Last Message',
                    'User ID'
                ]);
                console.log('Added headers to Google Sheet');
            }
        } catch (error) {
            console.error('Error ensuring headers:', error);
            throw error;
        }
    }

    async findUserRow(email: string, contactNumber: string): Promise<number | null> {
        try {
            const rows = await this.getRows('Sheet1!A2:F1000'); // Skip header row
            
            const normalizedEmail = email.toLowerCase().trim();
            const normalizedContact = contactNumber.replace(/\D/g, '');
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (row && row.length >= 3) {
                    const rowEmail = (row[1] || '').toLowerCase().trim();
                    const rowContact = (row[2] || '').replace(/\D/g, '');
                    
                    if (rowEmail === normalizedEmail && rowContact === normalizedContact) {
                        return i + 2; // +2 because we skipped header and array is 0-indexed
                    }
                }
            }
            
            return null;
        } catch (error) {
            console.error('Error finding user row:', error);
            return null;
        }
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
            body: JSON.stringify({
                values: [values]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('Google Sheets API Error:', error);
            throw new Error(`Failed to update Google Sheet: ${response.status} ${response.statusText}`);
        }
    }

    async saveConversation(email: string, contactNumber: string, messageCount: number, lastMessage: string, userId: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const values = [
            timestamp,
            email,
            contactNumber,
            String(messageCount),
            lastMessage.substring(0, 100), // Limit message length
            userId
        ];

        // Try to find existing row
        const existingRow = await this.findUserRow(email, contactNumber);
        
        if (existingRow) {
            // Update existing row
            await this.updateRow(existingRow, values);
            console.log(`Updated existing row ${existingRow} for ${email}`);
        } else {
            // Append new row
            await this.appendRow(values);
            console.log(`Added new row for ${email}`);
        }
    }
}
