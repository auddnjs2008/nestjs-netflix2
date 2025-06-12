import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadRequestException,
  Inject,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NextFunction, Request, Response } from 'express';
import { envVariableKeys } from 'src/common/const/env.const';

@Injectable()
export class BearerTokenMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      next();
      return;
    }
    const token = this.validateBearerToken(authHeader);

    const blockedToken = await this.cacheManager.get(`BLOCK_TOKEN_${token}`);

    if (blockedToken) {
      throw new UnauthorizedException('토큰이 블락되었습니다!');
    }

    const cachedPayload = await this.cacheManager.get(`TOKEN_${token}`);

    if (cachedPayload) {
      req.user = cachedPayload;
      next();
      return;
    }
    const decodedPayload = this.jwtService.decode(token);

    const isRefreshToken = decodedPayload.type === 'refresh';
    if (!isRefreshToken && decodedPayload.type !== 'access') {
      throw new UnauthorizedException('잘못된 토큰입니다');
    }

    try {
      const secretKey = isRefreshToken
        ? this.configService.get<string>(envVariableKeys.refreshTokenSecret)
        : this.configService.get<string>(envVariableKeys.accessTokenSecret);

      const payload = await this.jwtService.verifyAsync(token, {
        secret: secretKey,
      });

      /// payload['exp'] -> epoch time seconds
      const expiryDate = +new Date(payload['exp'] * 1000);
      const now = Date.now();

      const diff = (expiryDate - now) / 1000;

      await this.cacheManager.set(
        `TOKEN_${token}`,
        payload,
        Math.max(diff - 30, 1) * 1000,
      );

      req.user = payload;
      next();
    } catch (e) {
      console.log(e);
      if (e.name === 'TokenExpiredError') {
        throw new UnauthorizedException('토큰이 만료되었습니다!');
      }
      next();
    }
  }

  validateBearerToken(rawToken: string) {
    ///1) 토큰을 ' ' 기준으로 스플릿 한 후 토큰 값만 추출
    const basicSplit = rawToken.split(' ');

    if (basicSplit.length !== 2) {
      throw new BadRequestException('토큰 포맷이 잘못되었습니다!');
    }

    const [bearer, token] = basicSplit;

    if (bearer.toLowerCase() !== 'bearer') {
      throw new BadRequestException('토큰 포맷이 잘못되었습니다!');
    }
    return token;
  }
}
