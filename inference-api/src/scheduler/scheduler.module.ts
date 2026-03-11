import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { BatchCollector } from './batch-collector';
import { WorkerOrchestratorModule } from '../worker-orchestrator/worker-orchestrator.module';
import { TokenizerModule } from '../tokenizer/tokenizer.module';

@Module({
  imports: [WorkerOrchestratorModule, TokenizerModule],
  providers: [SchedulerService, BatchCollector],
  exports: [SchedulerService],
})
export class SchedulerModule {}
