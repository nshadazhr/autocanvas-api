import { BadRequestException } from '@nestjs/common';

type WavInfo = {
	audioFormat: number;
	channels: number;
	sampleRate: number;
	bitsPerSample: number;
	blockAlign: number;
	pcm: Buffer;
};

function parseWav(buffer: Buffer): WavInfo {
	if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
		throw new BadRequestException('Invalid WAV file');
	}

	let offset = 12;
	let format: Omit<WavInfo, 'pcm'> | null = null;
	const dataChunks: Buffer[] = [];

	while (offset + 8 <= buffer.length) {
		const chunkId = buffer.toString('ascii', offset, offset + 4);
		const chunkSize = buffer.readUInt32LE(offset + 4);
		const start = offset + 8;
		const end = start + chunkSize;

		if (end > buffer.length) {
			throw new BadRequestException('Corrupted WAV file');
		}

		if (chunkId === 'fmt ') {
			if (chunkSize < 16) {
				throw new BadRequestException('Invalid WAV format');
			}

			format = {
				audioFormat: buffer.readUInt16LE(start),
				channels: buffer.readUInt16LE(start + 2),
				sampleRate: buffer.readUInt32LE(start + 4),
				blockAlign: buffer.readUInt16LE(start + 12),
				bitsPerSample: buffer.readUInt16LE(start + 14)
			};
		}

		if (chunkId === 'data') {
			dataChunks.push(buffer.subarray(start, end));
		}

		offset = end + (chunkSize % 2);
	}

	if (!format || dataChunks.length === 0) {
		throw new BadRequestException('WAV format or audio data missing');
	}

	if (
		format.audioFormat !== 1 ||
		format.channels < 1 ||
		format.sampleRate < 1 ||
		![8, 16, 24, 32].includes(format.bitsPerSample) ||
		format.blockAlign !== (format.channels * format.bitsPerSample) / 8
	) {
		throw new BadRequestException('Unsupported PCM WAV format');
	}

	const pcm = Buffer.concat(dataChunks);

	if (pcm.length % format.blockAlign !== 0) {
		throw new BadRequestException('Invalid PCM sample alignment');
	}

	return { ...format, pcm };
}

export function mergeWavBuffers(buffers: Buffer[], silenceMs = 300): Buffer {
	if (buffers.length === 0) {
		throw new BadRequestException('No audio files to merge');
	}

	if (!Number.isInteger(silenceMs) || silenceMs < 0 || silenceMs > 10000) {
		throw new BadRequestException('Invalid silence duration');
	}

	const files = buffers.map(parseWav);
	const first = files[0];

	for (const file of files) {
		if (
			file.audioFormat !== first.audioFormat ||
			file.channels !== first.channels ||
			file.sampleRate !== first.sampleRate ||
			file.bitsPerSample !== first.bitsPerSample
		) {
			throw new BadRequestException('All WAV files must use the same PCM format');
		}
	}

	const silenceFrames = Math.round((first.sampleRate * silenceMs) / 1000);
	const silence = Buffer.alloc(silenceFrames * first.blockAlign);

	// 8-bit PCM uses unsigned samples, where silence is 128.
	if (first.bitsPerSample === 8) {
		silence.fill(128);
	}

	const parts: Buffer[] = [];

	files.forEach((file, index) => {
		if (index > 0 && silence.length > 0) {
			parts.push(silence);
		}

		parts.push(file.pcm);
	});

	const pcm = Buffer.concat(parts);
	const dataPadding = pcm.length % 2;
	const riffSize = 36 + pcm.length + dataPadding;

	if (riffSize > 0xffffffff) {
		throw new BadRequestException('Merged WAV exceeds 4 GB limit');
	}

	const header = Buffer.alloc(44);

	header.write('RIFF', 0, 'ascii');
	header.writeUInt32LE(riffSize, 4);
	header.write('WAVE', 8, 'ascii');
	header.write('fmt ', 12, 'ascii');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(first.channels, 22);
	header.writeUInt32LE(first.sampleRate, 24);
	header.writeUInt32LE(first.sampleRate * first.blockAlign, 28);
	header.writeUInt16LE(first.blockAlign, 32);
	header.writeUInt16LE(first.bitsPerSample, 34);
	header.write('data', 36, 'ascii');
	header.writeUInt32LE(pcm.length, 40);

	return Buffer.concat([header, pcm, ...(dataPadding ? [Buffer.alloc(1)] : [])]);
}
