# Introduction

The intent of this project is to build an externally hosted app for SFMC that can be published in Salesforce AppExchange which uses features of SFMC to Send SMS, Whatsapp and Line messages along with Event notification services and dynamic ampscript to create a two way conversation application.

# How it works? 

## Mobile Connect SMS 

The application, for an available short code, will create an Outbound Message with ampscript %%=v(@typedMessage)=%% as the only value that can be invoked via API call. So, in the conversation chat UI, when a user selects an available contact, and types a message, it goes to the customer and then when the customer responds back, it gets displayed to the user. To show customer response, use event notification services. 

## Whatsapp Channel 

Follows a similar approach and Event notification services support customers' response to whatsapp message. See docs below.

https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/engagement_ott_events_mobile_originated.html