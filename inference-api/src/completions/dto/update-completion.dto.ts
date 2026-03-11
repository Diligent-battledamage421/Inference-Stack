import { PartialType } from '@nestjs/mapped-types';
import { CreateCompletionDto } from './create-completion.dto';

export class UpdateCompletionDto extends PartialType(CreateCompletionDto) {}
