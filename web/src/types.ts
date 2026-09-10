export type Direction = 'outbound' | 'inbound';

export type DeliveryStatus =
  | 'pending'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'received';

export type SubscriptionState = 'subscribed' | 'unsubscribed' | 'in_progress' | 'unknown';

export interface Contact {
  id: string;
  contactKey?: string;
  mobileNumber: string;
  firstName?: string;
  lastName?: string;
  subscriptionStatus: SubscriptionState;
}

export interface Conversation {
  id: string;
  channel: string;
  contact: Contact;
  channelAddress: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  unreadCount: number;
}

export interface Message {
  id: string;
  conversationId: string;
  channel: string;
  direction: Direction;
  body: string;
  status: DeliveryStatus;
  statusCode?: number;
  providerMessageId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** A short or long code the agent can start a conversation on. */
export interface MessagingCode {
  code: string;
  countryCode: string;
}

export interface AppConfig {
  mode: string;
  keyword: string;
  canSend: boolean;
  codes: MessagingCode[];
}

export interface SubscriptionRecord {
  mobileNumber: string;
  subscriberKey?: string;
  shortCode?: string;
  keyword?: string;
  optInDate?: string;
  status: SubscriptionState;
}

/** A subscriber found by search. Always has a phone number, or it is not returned. */
export interface SubscriberMatch {
  mobileNumber: string;
  subscriberKey?: string;
  emailAddress?: string;
  subscriptions: SubscriptionRecord[];
}

export interface AddedConversation {
  conversation: Conversation;
  optIn: {
    keyword: string;
    shortCode: string;
    confirmed: boolean;
    detail: string;
  };
}

export type ServerEvent =
  | { type: 'ready' }
  | { type: 'message.created'; message: Message; conversation: Conversation }
  | { type: 'message.updated'; message: Message }
  | { type: 'conversation.updated'; conversation: Conversation };
