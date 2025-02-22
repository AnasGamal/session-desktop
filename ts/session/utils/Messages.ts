import { RawMessage } from '../types/RawMessage';

import { EncryptionType, PubKey } from '../types';
import { ClosedGroupMessage } from '../messages/outgoing/controlMessage/group/ClosedGroupMessage';
import { ClosedGroupNewMessage } from '../messages/outgoing/controlMessage/group/ClosedGroupNewMessage';
import { ClosedGroupEncryptionPairReplyMessage } from '../messages/outgoing/controlMessage/group/ClosedGroupEncryptionPairReplyMessage';
import { ContentMessage } from '../messages/outgoing';
import { ExpirationTimerUpdateMessage } from '../messages/outgoing/controlMessage/ExpirationTimerUpdateMessage';

function getEncryptionTypeFromMessageType(
  message: ContentMessage,
  isGroup = false
): EncryptionType {
  // ClosedGroupNewMessage is sent using established channels, so using fallback
  if (
    message instanceof ClosedGroupNewMessage ||
    message instanceof ClosedGroupEncryptionPairReplyMessage
  ) {
    return EncryptionType.Fallback;
  }

  // 1. any ClosedGroupMessage which is not a ClosedGroupNewMessage must be encoded with ClosedGroup
  // 2. if TypingMessage or ExpirationTimer and groupId is set => must be encoded with ClosedGroup too
  if (
    message instanceof ClosedGroupMessage ||
    (message instanceof ExpirationTimerUpdateMessage && message.groupId) ||
    isGroup
  ) {
    return EncryptionType.ClosedGroup;
  } else {
    return EncryptionType.Fallback;
  }
}

export async function toRawMessage(
  destinationPubKey: PubKey,
  message: ContentMessage,
  isGroup = false
): Promise<RawMessage> {
  const ttl = message.ttl();
  const plainTextBuffer = message.plainTextBuffer();

  const encryption = getEncryptionTypeFromMessageType(message, isGroup);

  // tslint:disable-next-line: no-unnecessary-local-variable
  const rawMessage: RawMessage = {
    identifier: message.identifier,
    plainTextBuffer,
    device: destinationPubKey.key,
    ttl,
    encryption,
  };

  return rawMessage;
}
