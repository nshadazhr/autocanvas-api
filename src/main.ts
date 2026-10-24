import { authAllowedOrigins } from './auth/services/auth-origins.js';
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';

async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule, {
		instrument: ObserveInstrument
	});

	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	);

	app.enableCors({
		origin: authAllowedOrigins(),
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization'],
		credentials: true
	});

	app.use(cookieParser());

	app.useStaticAssets(join(process.cwd(), 'uploads'), {
		prefix: '/uploads/'
	});

	const config = new DocumentBuilder()
		.setTitle('Autocanvas API Docs')
		.setDescription('Autocanvas API Docs Descrition')
		.setVersion('1.0')
		.addTag('autocanvas')
		.build();

	const documentFactory = () => SwaggerModule.createDocument(app, config);

	SwaggerModule.setup('swagger/json', app, documentFactory);

	await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
