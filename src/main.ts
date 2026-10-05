import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  console.log('process.env.JWT_SECRET', process.env.JWT_SECRET);
  
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  app.useGlobalPipes(new ValidationPipe());
  const config = new DocumentBuilder()
    .setTitle('Autocanvas API Docs')
    .setDescription('Autocanvas API Docs Descrition')
    .setVersion('1.0')
    .addTag('autocanvas')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('swagger/json', app, documentFactory);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
