import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './events/redis-io.adapter';

async function bootstrap() {
  // rawBody: el aviso de pagos se verifica con una firma HMAC sobre el cuerpo tal cual llegó
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Detrás de nginx en la misma máquina: la IP real del cliente viene en X-Forwarded-For
  app.set('trust proxy', 'loopback');

  // WebSocket adapter with Redis pub/sub for multi-instance support
  const configService = app.get(ConfigService);
  const redisIoAdapter = new RedisIoAdapter(app, configService);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.setGlobalPrefix('api/v1');
  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('FacturaEC API')
    .setDescription(
      '## SaaS de Facturación Electrónica para Ecuador (SRI)\n\n' +
      '### Autenticación\n\n' +
      '- **Panel Admin/Client**: Bearer JWT obtenido en `/api/v1/auth/admin/login` o `/api/v1/auth/client/login`\n' +
      '- **API Pública (documentos)**: Header `X-API-Key` con la clave API de la empresa (Company API Key)\n' +
      '- **API Cuenta (gestión de empresas)**: Header `X-Account-Key` con la clave API de la cuenta (Account API Key)\n\n' +
      '### API Pública — Documentos\n\n' +
      'Los endpoints de la API pública identifican documentos por su **clave de acceso** (49 dígitos numéricos), ' +
      'no por ID interno. La clave de acceso es generada al crear el documento y se retorna en la respuesta.\n\n' +
      '| Endpoint | Descripción |\n' +
      '|----------|-------------|\n' +
      '| `POST /documents` | Crear documento (async) |\n' +
      '| `POST /documents/emit` | Crear documento (sync) |\n' +
      '| `PUT /documents/{claveAcceso}` | Corregir y reprocesar (async) |\n' +
      '| `PUT /documents/{claveAcceso}/emit` | Corregir y reprocesar (sync) |\n' +
      '| `POST /documents/{claveAcceso}/retry-authorization` | Reintentar autorización |\n' +
      '| `GET /documents` | Listar documentos |\n' +
      '| `GET /documents/{claveAcceso}` | Detalle de documento |\n' +
      '| `GET /documents/{claveAcceso}/files/{fileType}` | Descargar archivo (signed_xml, authorized_xml, ride) |\n',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
    .addApiKey({ type: 'apiKey', name: 'X-Account-Key', in: 'header' }, 'account-key')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`FacturaEC API running on http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}
bootstrap();
