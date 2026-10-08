import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserAuthGuard } from './auth.guards';
import { UserRequest } from './auth.guards';
import { BindCharacterNfcTagDto, UpdateCharacterPromptDto } from './dto';
import { StoreService } from './store.service';

@Controller('characters')
@UseGuards(UserAuthGuard)
export class CharactersController {
  constructor(private readonly store: StoreService) {}

  @Get()
  listCharacters() {
    return this.store.listCharacters();
  }

  @Patch(':characterId/prompt')
  updatePrompt(
    @Req() request: UserRequest,
    @Param('characterId') characterId: string,
    @Body() dto: UpdateCharacterPromptDto,
  ) {
    return this.store.updateCharacterPrompt(
      request.user.id,
      characterId,
      dto.prompt,
    );
  }

  @Put(':characterId/nfc-tag')
  bindNfcTag(
    @Req() request: UserRequest,
    @Param('characterId') characterId: string,
    @Body() dto: BindCharacterNfcTagDto,
  ) {
    return this.store.bindCharacterNfcTag(
      request.user.id,
      characterId,
      dto.uid,
    );
  }

  @Delete(':characterId/nfc-tag')
  unbindNfcTag(
    @Req() request: UserRequest,
    @Param('characterId') characterId: string,
  ) {
    return this.store.unbindCharacterNfcTag(request.user.id, characterId);
  }
}
