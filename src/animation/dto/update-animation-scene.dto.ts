import { PartialType } from '@nestjs/mapped-types';
import { CreateAnimationSceneDto } from './create-animation-scene.dto.js';

export class UpdateAnimationSceneDto extends PartialType(CreateAnimationSceneDto) {}
