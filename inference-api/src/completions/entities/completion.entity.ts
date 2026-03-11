import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity()
export class Completion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  model: string;

  @Column({ type: 'text' })
  prompt: string;

  @Column({ type: 'text', nullable: true })
  completion_text: string;

  @Column({ default: false })
  stream: boolean;

  @Column({ default: 'completed' })
  status: string; // 'pending' | 'streaming' | 'completed' | 'error'

  @Column({ nullable: true })
  finish_reason: string;

  // Usage stats
  @Column({ default: 0 })
  prompt_tokens: number;

  @Column({ default: 0 })
  completion_tokens: number;

  @Column({ default: 0 })
  total_tokens: number;

  // Timing
  @Column({ type: 'float', default: 0 })
  prefill_time_ms: number;

  @Column({ type: 'float', default: 0 })
  decode_time_ms: number;

  @Column({ type: 'float', default: 0 })
  total_time_ms: number;

  // Generation params (stored for replay/debugging)
  @Column({ type: 'float', default: 1.0 })
  temperature: number;

  @Column({ default: 50 })
  max_tokens: number;

  @Column({ type: 'float', default: 1.0 })
  top_p: number;

  @Column({ nullable: true })
  error_message: string;

  @Column({ nullable: true })
  worker_id: string;

  @CreateDateColumn()
  created_at: Date;
}
