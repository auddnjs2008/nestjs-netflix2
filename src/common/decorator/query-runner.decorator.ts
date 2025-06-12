import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';

export const QueryRunner = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    if (!request || !request.queryRunner) {
      throw new InternalServerErrorException(
        'QueryRunner 인스턴스를 찾을 수 없습니다!',
      );
    }

    return request.queryRunner;
  },
);
