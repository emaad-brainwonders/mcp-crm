import type { User } from "@workos-inc/node";

export interface Props {
	user: User;
	accessToken: string;
	refreshToken: string;
	permissions: string[];
	organizationId?: string;

	contactNumber?: string;

	// Required to satisfy McpAgent<Props>
	[key: string]: unknown;
}
