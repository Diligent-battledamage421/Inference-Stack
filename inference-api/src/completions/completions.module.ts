import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompletionsService } from './completions.service';
import { CompletionsController } from './completions.controller';
import { Completion } from './entities/completion.entity';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { TokenizerModule } from '../tokenizer/tokenizer.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Completion]),
    SchedulerModule,
    TokenizerModule,
  ],
  controllers: [CompletionsController],
  providers: [CompletionsService],
})
export class CompletionsModule {}
