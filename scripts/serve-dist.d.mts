import type { Server } from "node:http";

export function createPagesServer(options: { root: string; base: string }): Server;
export function listen(server: Server, port?: number): Promise<number>;
