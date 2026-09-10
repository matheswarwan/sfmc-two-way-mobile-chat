import type { Config, MessagingCode } from '../config/index.js';
import type { SfmcClient } from '../sfmc/client.js';
import { SfmcApiError } from '../sfmc/client.js';
import type { SfmcProvisioner } from '../sfmc/provisioning.js';
import { INBOUND_MESSAGE_NAME, OUTBOUND_DEFINITION_NAME } from '../sfmc/provisioning.js';
import type { EnsService } from '../ens/service.js';

export type StepState = 'ok' | 'missing' | 'error' | 'manual' | 'unknown';

export interface SetupStep {
  id: string;
  title: string;
  /** Whether the app can create this, or whether a human must. */
  automatable: boolean;
  state: StepState;
  detail: string;
  /** Instructions shown when the step needs human action. */
  instructions?: string[];
  docsUrl?: string;
}

/**
 * Builds a live picture of the tenant's setup.
 *
 * Every automatable step is verified by actually calling SFMC rather than by
 * checking that an environment variable is non-empty, because the common
 * failure is a value that is set but wrong - a mistyped key, or a token scoped
 * to the wrong business unit.
 */
export class SetupStatusService {
  #config: Config;
  #client: SfmcClient;
  #provisioner: SfmcProvisioner;
  #ens: EnsService | undefined;

  constructor(
    config: Config,
    client: SfmcClient,
    provisioner: SfmcProvisioner,
    ens?: EnsService,
  ) {
    this.#config = config;
    this.#client = client;
    this.#provisioner = provisioner;
    this.#ens = ens;
  }

  async getSteps(): Promise<SetupStep[]> {
    // One send definition per code: a definition binds to exactly one
    // shortCode/keyword pair, so several codes mean several steps.
    const codes = this.#config.sfmc.codes;

    const [dataExtension, sendDefinitions, textResponse] = await Promise.all([
      this.#checkDataExtension(),
      codes.length === 0
        ? Promise.resolve([this.#noCodeSendDefinitionStep()])
        : Promise.all(codes.map((code) => this.#checkSendDefinition(code))),
      this.#checkTextResponse(),
    ]);

    return [
      this.#installedPackageStep(),
      this.#shortCodeStep(),
      dataExtension,
      ...sendDefinitions,
      textResponse,
      this.#conversationWindowStep(),
      this.#deliveryEventsStep(),
    ];
  }

  /**
   * Placeholder shown before any code is configured.
   *
   * Kept as a step rather than omitted so the screen still reads as a complete
   * checklist, and so the reason it cannot be actioned is on screen.
   */
  #noCodeSendDefinitionStep(): SetupStep {
    return {
      id: 'send-definition',
      title: 'Send definition',
      automatable: false,
      state: 'missing',
      detail: 'Needs a short or long code first.',
    };
  }

  async #checkDataExtension(): Promise<SetupStep> {
    const key = this.#config.sfmc.inboundDataExtensionKey;
    const base = {
      id: 'data-extension',
      title: `Inbound Data Extension "${key}"`,
      automatable: true,
    };

    try {
      await this.#client.readInboundRows(new Date(Date.now() - 60_000).toISOString());
      return { ...base, state: 'ok', detail: 'Exists and is readable.' };
    } catch (error) {
      if (error instanceof SfmcApiError && error.status === 404) {
        return { ...base, state: 'missing', detail: 'Does not exist yet. Can be created for you.' };
      }
      if (error instanceof SfmcApiError && (error.status === 401 || error.status === 403)) {
        return {
          ...base,
          state: 'error',
          detail: 'Access denied. The package likely lacks data_extensions_read.',
        };
      }
      return {
        ...base,
        state: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The step id carries the code, so the provision button can name which of
   * several definitions it is creating.
   */
  async #checkSendDefinition(code: MessagingCode): Promise<SetupStep> {
    const base = {
      id: `send-definition:${code.code}`,
      title: `Send definition "${code.definitionKey}" on ${code.code}`,
      automatable: true,
    };

    try {
      const result = await this.#provisioner.getSendDefinition(code.code);
      if (!result.exists) {
        return { ...base, state: 'missing', detail: 'Does not exist yet. Can be created for you.' };
      }

      const isActive = (result.status ?? '').toLowerCase() === 'active';
      return isActive
        ? { ...base, state: 'ok', detail: 'Exists and is active.' }
        : {
            ...base,
            state: 'error',
            detail: `Exists but its status is "${result.status ?? 'unknown'}". An inactive definition will not send. Transactional definitions are API-managed and do not appear in the MobileConnect UI, so use the button here to activate it.`,
          };
    } catch (error) {
      return {
        ...base,
        state: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  #installedPackageStep(): SetupStep {
    const configured = Boolean(this.#config.sfmc.clientId && this.#config.sfmc.clientSecret);
    return {
      id: 'installed-package',
      title: 'Installed Package with an API Integration',
      automatable: false,
      state: configured ? 'ok' : 'manual',
      detail: configured
        ? 'Credentials are present in .env.'
        : 'No credentials found. This is the bootstrap step.',
      instructions: [
        'In SFMC: Setup, then Apps, then Installed Packages, then New.',
        'Add Component, then API Integration, then Server-to-Server.',
        'Grant these scopes: sms_read, sms_send, sms_write, data_extensions_read, data_extensions_write, list_and_subscribers_read.',
        'Copy the client ID and secret into .env. The secret is shown only once and cannot be recovered.',
        'Note that an API Integration component can never be removed from a package once added.',
        'Changes take up to 5 minutes to propagate.',
      ],
      docsUrl:
        'https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/create-integration-enhanced.html',
    };
  }

  #shortCodeStep(): SetupStep {
    const codes = this.#config.sfmc.codes;
    const summary = codes
      .map((entry) => (entry.countryCode ? `${entry.code} (${entry.countryCode})` : entry.code))
      .join(', ');

    return {
      id: 'short-code',
      title: codes.length > 1 ? 'Short or long codes' : 'Short or long code',
      automatable: false,
      state: codes.length > 0 ? 'ok' : 'manual',
      detail:
        codes.length > 0
          ? `Using ${summary}. The first is the default for new conversations.`
          : 'Not set. Procurement takes weeks, so start early.',
      instructions: [
        'Short codes are procured through your Salesforce Account Executive, not self-service.',
        'Carrier approval takes weeks. Begin this before anything else.',
        'For one code, set SFMC_SHORT_CODE and SFMC_COUNTRY_CODE in .env.',
        'For several, set SFMC_SHORT_CODES to a comma-separated list of code:countryCode entries, for example "86288:US,447700900123". Omit the country code for a long code.',
        'The agent picks which code a new conversation starts on, so every code listed here needs its own keyword and send definition.',
      ],
      docsUrl: 'https://help.salesforce.com/s/articleView?id=000383747&type=1',
    };
  }

  /**
   * Verified, not assumed.
   *
   * MO keyword objects are Retrieve-only and appear once a Text Response binds
   * behaviour to a keyword, so a non-zero count is real evidence the manual
   * step is done. If the check cannot run we say so rather than guessing.
   */
  async #checkTextResponse(): Promise<SetupStep> {
    const base = {
      id: 'text-response',
      title: 'MobileConnect Text Response message',
      automatable: false,
      instructions: [
        'In SFMC: MobileConnect, then Messages, then Create Message.',
        'Choose the Text Response template.',
        `Name it: ${INBOUND_MESSAGE_NAME}`,
        `Short/long code: ${this.#config.sfmc.shortCode || '(set SFMC_SHORT_CODE first)'}`,
        `Keyword: ${this.#config.sfmc.keyword}`,
        'Paste the generated AMPscript below into the response body.',
        'Activate the message, then use Run verification.',
        `Note this is the inbound counterpart to the outbound send definition "${OUTBOUND_DEFINITION_NAME}", which is API-managed and does not appear in the MobileConnect UI. They are separate objects.`,
      ],
      docsUrl: 'https://help.salesforce.com/s/articleView?id=sf.mc_moc_text_response.htm&type=5',
    };

    const count = await this.#provisioner.countBoundMoKeywords();

    if (count === undefined) {
      return {
        ...base,
        state: 'manual',
        detail:
          'Could not check. SFMC has no API to create a MobileConnect message, so this step is manual either way.',
      };
    }
    if (count > 0) {
      return {
        ...base,
        state: 'ok',
        detail: `Detected ${count} bound MO keyword object(s). A Text Response is wired up. Use Run verification to confirm it captures correctly.`,
      };
    }
    return {
      ...base,
      state: 'manual',
      detail:
        'No bound MO keyword found, so no Text Response is handling inbound yet. This cannot be automated: SFMC exposes no API to create a MobileConnect message, and the MO keyword objects are Retrieve-only.',
    };
  }

  /**
   * Delivery receipts via Event Notification Service.
   *
   * Optional: without it, an outbound message stays at "queued" in the UI.
   * Two things gate it - a public HTTPS callback URL, and the fact that these
   * are Transactional Send Events, so a MobileConnect send emits nothing.
   */
  #deliveryEventsStep(): SetupStep {
    const base = {
      id: 'delivery-events',
      title: 'Delivery receipts (Event Notification Service)',
      automatable: true,
      docsUrl: 'https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/ens.html',
    };

    const registration = this.#ens?.getRegistration();
    const url = this.#config.ens.callbackUrl;

    const instructions = [
      'Optional. Without this, sent messages stay at "Queued" in the chat view.',
      'Add the Event Notifications scopes to your Installed Package: Callbacks and Subscriptions, each with Read, Create, Update and Delete.',
      'Expose this server on a public HTTPS URL. SFMC rejects ports and query strings, so use a tunnel or a deployed host.',
      'Set ENS_CALLBACK_URL to that URL plus /ens/callback, then restart.',
      `Delivery events are Transactional Send Events, so they only fire on the transactional transport. This app is currently sending via "${this.#config.outboundTransport}".`,
    ];

    if (!url) {
      return { ...base, state: 'manual', detail: 'ENS_CALLBACK_URL is not set.', instructions };
    }
    if (!registration) {
      return {
        ...base,
        state: 'missing',
        detail: `Not registered. Will register ${url} and store the signature key.`,
        instructions,
      };
    }
    if (!registration.verified) {
      return {
        ...base,
        state: 'missing',
        detail: 'Callback created but not verified. Use the button to complete verification.',
        instructions,
      };
    }
    if (!registration.subscriptionId) {
      return {
        ...base,
        state: 'missing',
        detail: 'Callback verified. Subscribe to the SMS delivery events.',
        instructions,
      };
    }
    return {
      ...base,
      state: this.#config.outboundTransport === 'transactional' ? 'ok' : 'error',
      detail:
        this.#config.outboundTransport === 'transactional'
          ? `Subscribed. Delivery receipts will update message status live.`
          : `Subscribed, but the app is sending via the mobileconnect transport, which does not emit these events. Set SFMC_OUTBOUND_TRANSPORT=transactional to receive them.`,
      instructions,
    };
  }

  #conversationWindowStep(): SetupStep {
    return {
      id: 'conversation-window',
      title: 'Conversation window',
      automatable: false,
      state: 'manual',
      detail:
        'Setup UI only, no API. Range is 10 minutes to 7 days and the default is 60 minutes, which is usually too short for a support conversation.',
      instructions: [
        'In SFMC: Setup, then search MobileConnect.',
        'Select your code from the Short/Long Code list.',
        'In the Keyword Management grid, set the Conversation Window for your keyword.',
        'This is what lets a customer reply in plain prose instead of starting with a keyword.',
        'Raise it above the 60 minute default if you expect slower conversations.',
      ],
      docsUrl:
        'https://help.salesforce.com/s/articleView?id=sf.mc_moc_configure_conversation_window.htm&type=5',
    };
  }
}

/**
 * Produces the AMPscript for the Text Response message, with the tenant's own
 * values already substituted so it can be pasted without editing.
 */
export function generateTextResponseAmpscript(config: Config, webhookUrl?: string): string {
  const de = config.sfmc.inboundDataExtensionKey;
  const keyword = config.sfmc.keyword;

  const webhookBlock = webhookUrl
    ? `
/* Real-time push. UNVERIFIED: Salesforce documents neither support nor
   prohibition for AMPscript HTTP functions inside a MobileConnect message.
   Test this before relying on it - a slow endpoint delays the customer's SMS. */
SET @payload = Concat(
  '{"mobileNumber":"', @mobileNumber,
  '","body":"',        Replace(@text, '"', '\\"'),
  '","shortCode":"',   @shortCode,
  '","messageId":"',   @messageId,
  '","receivedAt":"',  @receivedAt, '"}'
)
SET @status = HttpPost2("${webhookUrl}", "application/json", @payload, false, @response)
`
    : '';

  return `%%[
/* Generated by the two-way chat app.
   Paste into the MobileConnect Text Response message "${INBOUND_MESSAGE_NAME}"
   on keyword "${keyword}", code ${config.sfmc.shortCode || '(not set)'}.

   This runs synchronously in the customer's reply path, so keep it cheap. */

SET @rawMessage   = Msg(0)
SET @keyword      = Msg(0).Verb
SET @mobileNumber = AttributeValue("MobileNumber")
SET @shortCode    = AttributeValue("ShortCode")
SET @receivedAt   = FormatDate(Now(), "yyyy-MM-ddTHH:mm:ss.fff", "", "UTC")
SET @messageId    = Concat(@mobileNumber, ":", @receivedAt)

/* Keep the whole inbound text: a chat customer types prose, not keywords. */
IF Empty(@rawMessage) THEN
  SET @text = Msg(0).Nouns
ELSE
  SET @text = @rawMessage
ENDIF

/* InsertData is one of only two non-mobile AMPscript functions Salesforce
   documents as usable in MobileConnect messages. This is the durable path. */
InsertData(
  "${de}",
  "MessageId",     @messageId,
  "MobileNumber",  @mobileNumber,
  "SubscriberKey", _subscriberkey,
  "MessageBody",   @text,
  "Keyword",       @keyword,
  "ShortCode",     @shortCode,
  "ReceivedAt",    @receivedAt
)
${webhookBlock}
/* Re-arm so the next reply routes here without needing a keyword. */
SetSmsConversationNextKeyword(@shortCode, @mobileNumber, "${keyword}")
]%%`;
}
