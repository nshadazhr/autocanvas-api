import { PartialType } from '@nestjs/mapped-types';
import { CreateAnimationProjectDto } from './create-animation-project.dto.js';

export class UpdateAnimationProjectDto extends PartialType(CreateAnimationProjectDto) {}
