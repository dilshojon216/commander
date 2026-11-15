import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';

export const BODY_LIMIT = '64kb';

/** Shared by main.ts and the e2e tests so both run with identical pipes and limits. */
export function configureApp(app: NestExpressApplication): void {
  // Xom tana (imzo uchun) `NestFactory.create(..., { bodyParser: false, rawBody: true })` orqali `req.rawBody` ga tushadi.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  // `ws` adapteri (Socket.IO emas). Nest'ning {event,data} marshrutlashi o'chirilgan: kontrakt envelope'ini
  // gateway o'zi o'qiydi (agent.gateway.ts), shu sabab adapter parseri hech narsa qaytarmaydi.
  app.useWebSocketAdapter(new WsAdapter(app, { messageParser: () => undefined }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // drop unknown fields...
      forbidNonWhitelisted: false, // ...instead of rejecting the request
      transform: true,
    }),
  );
}
