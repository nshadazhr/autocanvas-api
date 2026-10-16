import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AiService } from './ai/ai.service.js';
import { writeFile } from 'node:fs/promises';
import wavefile from 'wavefile';

const { WaveFile } = wavefile;
async function main() {
	const app = await NestFactory.createApplicationContext(AppModule);

	try {
		const aiService = app.get(AiService);

		const response = await aiService.generateSpeech(
			'माँ, मैं गाँव में पिज़्ज़ा की दुकान खोलना चाहता हूँ।',
			'Zephyr',
			'gemini-2.5-flash-preview-tts'
		);

		console.log('TTS request completed:', {
			candidates: response.candidates?.length ?? 0
		});

		const audioPart = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data);

		const base64 = audioPart?.inlineData?.data;

		if (!base64) {
			throw new Error('Gemini returned no audio');
		}

		const pcmBuffer = Buffer.from(base64, 'base64');

		const samples = new Int16Array(pcmBuffer.length / 2);

		for (let i = 0; i < samples.length; i++) {
			samples[i] = pcmBuffer.readInt16LE(i * 2);
		}

		const wav = new WaveFile();
		wav.fromScratch(1, 24000, '16', Array.from(samples));

		await writeFile('test-tts.wav', wav.toBuffer());

		console.log('Audio samples:', samples.length);
		console.log('Audio peak:', Math.max(...samples.slice(0, 1000).map(Math.abs)));

		await writeFile('test-tts.wav', wav.toBuffer());

		console.log('WAV saved: test-tts.wav');
	} finally {
		await app.close();
	}
}

main().catch(error => {
	console.error('TTS test failed:', error);
	process.exitCode = 1;
});
