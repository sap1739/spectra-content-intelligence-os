import { Module } from '@nestjs/common';

import { BudgetController, OrganizationBudgetController } from './budget.controller';
import { BudgetService } from './budget.service';

@Module({
  controllers: [BudgetController, OrganizationBudgetController],
  providers: [BudgetService],
})
export class BudgetModule {}
