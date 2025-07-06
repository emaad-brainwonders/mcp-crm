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
                    'Session Summary',
                    'Chat History',
                    'User ID'
                ]);
            }
        }
    }

    private normalizeEmail(email: string): string {
        return email.trim().toLowerCase();
    }

    private normalizeContactNumber(contactNumber: string): string {
        // Remove all non-digit characters and normalize
        const digitsOnly = contactNumber.replace(/\D/g, '');
        
        // Handle different formats (e.g., +1234567890, 1234567890, etc.)
        if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
            return digitsOnly.substring(1); // Remove country code
        }
        if (digitsOnly.length === 10) {
            return digitsOnly;
        }
        
        // Return as-is if it doesn't match expected patterns
        return contactNumber.trim();
    }

    async findRowByEmailAndContact(email: string, contactNumber: string): Promise<{ rowIndex: number, values: string[] } | null> {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/Sheet1!A2:F1000`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
            }
        });
        
        if (!response.ok) {
            console.error('Failed to fetch rows:', await response.text());
            return null;
        }
        
        const data = await response.json() as { values?: string[][] };
        if (!data.values) {
            console.log('No data found in sheet');
            return null;
        }
        
        // Normalize the search criteria
        const normalizedEmail = this.normalizeEmail(email);
        const normalizedContact = this.normalizeContactNumber(contactNumber);
        
        console.log(`Searching for - Email: "${normalizedEmail}", Contact: "${normalizedContact}"`);
        
        for (let i = 0; i < data.values.length; i++) {
            const row = data.values[i];
            if (!row || row.length < 3) continue; // Skip incomplete rows
            
            const rowEmail = this.normalizeEmail(row[1] || '');
            const rowContact = this.normalizeContactNumber(row[2] || '');
            
            console.log(`Row ${i + 2}: Email="${rowEmail}", Contact="${rowContact}"`);
            
            // Check if both email and contact match
            if (rowEmail === normalizedEmail && rowContact === normalizedContact) {
                console.log(`Found exact match at row ${i + 2}`);
                return { rowIndex: i + 2, values: row }; // +2 because A2 is row 2
            }
        }
        
        console.log('No matching row found for both email and contact');
        return null;
    }

    async updateRow(rowIndex: number, values: string[]): Promise<void> {
        const range = `Sheet1!A${rowIndex}:F${rowIndex}`;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${range}?valueInputOption=USER_ENTERED`;
        
        console.log(`Updating row ${rowIndex} with values:`, values);
        
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
        
        console.log(`Successfully updated row ${rowIndex}`);
    }

    /**
     * Appends only new chat lines to the existing chat history cell for rows matching both email and contact.
     * If no matching row is found, creates a new row.
     * @param email User email
     * @param contactNumber User contact number
     * @param newChatLines Array of new chat lines to append
     * @param otherValues Other columns (timestamp, summary, userId, etc)
     */
    async appendChatLinesToRow(email: string, contactNumber: string, newChatLines: string[], otherValues: string[]): Promise<void> {
        console.log(`Attempting to append chat for Email: "${email}", Contact: "${contactNumber}"`);
        
        // Ensure we have valid inputs
        if (!email || !contactNumber) {
            console.error('Email or contact number is missing');
            throw new Error('Both email and contact number are required');
        }
        
        if (!newChatLines || newChatLines.length === 0) {
            console.log('No new chat lines to append');
            return;
        }
        
        const found = await this.findRowByEmailAndContact(email, contactNumber);
        
        if (found) {
            console.log(`Found existing row ${found.rowIndex}, updating with new chat lines...`);
            
            // Get existing chat history (column 5, index 4)
            const existingChatHistory = found.values[4] || '';
            
            // Append new chat lines
            const updatedChatHistory = existingChatHistory 
                ? existingChatHistory + '\n' + newChatLines.join('\n')
                : newChatLines.join('\n');
            
            // Update the row with new data
            // otherValues: [timestamp, summary, userId]
            const updatedRow = [
                otherValues[0], // timestamp
                email, 
                contactNumber, 
                otherValues[1], // summary
                updatedChatHistory, 
                otherValues[2] // userId
            ];
            
            await this.updateRow(found.rowIndex, updatedRow);
            console.log(`Successfully updated existing row ${found.rowIndex}`);
        } else {
            console.log(`No existing row found for email "${email}" and contact "${contactNumber}", creating new row...`);
            
            // Create new row
            const newRow = [
                otherValues[0], // timestamp
                email,
                contactNumber,
                otherValues[1], // summary
                newChatLines.join('\n'), // chat history
                otherValues[2] // userId
            ];
            
            await this.appendRow(newRow);
            console.log(`Successfully created new row for email "${email}" and contact "${contactNumber}"`);
        }
    }

    /**
     * Debug method to help identify issues
     */
    async debugAllRows(): Promise<void> {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/Sheet1!A1:F1000`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
            }
        });
        
        if (response.ok) {
            const data = await response.json() as { values?: string[][] };
            if (data.values) {
                console.log('All rows in sheet:');
                data.values.forEach((row, index) => {
                    if (index === 0) {
                        console.log(`Row ${index + 1} (Header):`, row);
                    } else {
                        const email = this.normalizeEmail(row[1] || '');
                        const contact = this.normalizeContactNumber(row[2] || '');
                        console.log(`Row ${index + 1}: Email="${email}", Contact="${contact}", Raw:`, row);
                    }
                });
            } else {
                console.log('No data found in sheet');
            }
        } else {
            console.error('Failed to fetch debug data:', await response.text());
        }
    }

    /**
     * Get all unique email-contact combinations in the sheet
     */
    async getUniqueEmailContactPairs(): Promise<Array<{email: string, contact: string, rowIndex: number}>> {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/Sheet1!A2:F1000`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
            }
        });
        
        if (!response.ok) {
            console.error('Failed to fetch rows:', await response.text());
            return [];
        }
        
        const data = await response.json() as { values?: string[][] };
        if (!data.values) return [];
        
        const pairs: Array<{email: string, contact: string, rowIndex: number}> = [];
        
        for (let i = 0; i < data.values.length; i++) {
            const row = data.values[i];
            if (!row || row.length < 3) continue;
            
            const email = this.normalizeEmail(row[1] || '');
            const contact = this.normalizeContactNumber(row[2] || '');
            
            if (email && contact) {
                pairs.push({
                    email,
                    contact,
                    rowIndex: i + 2 // +2 because A2 is row 2
                });
            }
        }
        
        return pairs;
    }
}
