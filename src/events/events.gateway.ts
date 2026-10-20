import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwtPayload } from '../auth/strategies/jwt.strategy';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/events',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(private readonly config: ConfigService) {}

  handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Client ${client.id} — no token, disconnecting`);
        client.disconnect();
        return;
      }

      const secret = this.config.get<string>('JWT_SECRET')!;
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as unknown as JwtPayload;

      // Join role-based rooms
      if (payload.role === 'platform_admin') {
        client.join('admin');
        this.logger.log(`Admin ${payload.email} connected (${client.id})`);
      } else if (payload.role === 'account_user' && payload.accountId) {
        client.join(`account:${payload.accountId}`);
        this.logger.log(`User ${payload.email} (account ${payload.accountId}) connected (${client.id})`);
      }

      // Store user data on socket for later use
      (client as any).user = payload;
    } catch (err: any) {
      this.logger.warn(`Client ${client.id} — invalid token: ${err.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Emit a document status change to relevant rooms.
   * Redis adapter (set in main.ts) ensures this reaches all instances.
   */
  emitDocumentUpdate(data: {
    documentId: number;
    status: string;
    companyId: number;
    accountId: number;
    accessKey?: string;
    authNumber?: string;
    typeCode?: string;
    sequential?: string;
  }) {
    const event = 'document:status';

    // Notify the account that owns the document
    this.server.to(`account:${data.accountId}`).emit(event, data);

    // Notify admins
    this.server.to('admin').emit(event, data);

    this.logger.debug(`Emitted ${event} for doc ${data.documentId} → status=${data.status}`);
  }
}
