// **Imports and Global Declarations**
import { DynamoDBClient, QueryCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import OpenAI from "openai"; // Old import style
import { randomUUID, createHash } from "crypto";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// Initialize AJV for JSON schema validation
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

// **Environment Variables**
const TABLE_NAME = process.env.TABLE_NAME;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Validate environment variables
if (!OPENAI_API_KEY) {
  console.error("OpenAI API key is not set in environment variables.");
  throw new Error("Internal server error.");
}

if (!TABLE_NAME) {
  console.error("DynamoDB table name is not set in environment variables.");
  throw new Error("Internal server error.");
}

// **Initialize OpenAI Client Using Old SDK Syntax**
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// **Define the Input Schema for OpenAI Data (Excluding System Fields)**
const inputSchema = {
  type: "object",
  properties: {
    ItemType: { type: "string", enum: ["ingredient", "nutrient"] },
    // Common fields
    Name: {
      oneOf: [
        { type: "string" }, // For nutrients
        {
          type: "object", // For ingredients
          properties: {
            English: { type: "string" },
            Chinese: { type: "string" },
            Spanish: { type: "string" },
          },
          required: ["English"],
          additionalProperties: false,
        },
      ],
    },
    // Additional properties based on ItemType
    // Ingredient properties
    AlternateNames: { type: "array", items: { type: "string" } },
    Description: {
      oneOf: [
        { type: "string" }, // For nutrients
        {
          type: "object",
          properties: {
            English: { type: "string" },
            Chinese: { type: "string" },
            Spanish: { type: "string" },
          },
          required: ["English"],
          additionalProperties: false,
        },
      ],
    },
    YinYangClassification: {
      type: "string",
      enum: ["Yin (Cold)", "Yin (Cool)", "Neutral", "Yang (Warm)", "Yang (Hot)"],
    },
    FiveElements: { type: "string" },
    Category: { type: "string" },
    FlavorProfile: { type: "array", items: { type: "string" } },
    MedicinalProperties: { type: "array", items: { type: "string" } },
    CommonCulinaryUses: { type: "array", items: { type: "string" } },
    OriginRegion: { type: "string" },
    SeasonalAvailability: { type: "string" },
    NutritionalInformation: { type: "object", additionalProperties: true },
    AllergenInformation: { type: "string" },
    PreparationTips: { type: "array", items: { type: "string" } },
    DietaryRestrictions: { type: "array", items: { type: "string" } },
    SubstituteIngredients: { type: "array", items: { type: "string" } },
    StorageMethods: { type: "object", additionalProperties: true },
    CulinaryTechniques: { type: "array", items: { type: "string" } },
    CulturalSignificance: { type: "object", additionalProperties: true },
    HistoricalUsage: { type: "object", additionalProperties: true },
    EnvironmentalImpact: { type: "object", additionalProperties: true },
    TCMInformation: {
      type: "object",
      properties: {
        Functions: { type: "array", items: { type: "string" } },
        HerbalFormulations: { type: "array", items: { type: "string" } },
        Meridians: { type: "array", items: { type: "string" } },
      },
      required: ["Functions"],
      additionalProperties: false,
    },
    // Nutrient properties
    Type: { type: "string", enum: ["vitamin", "mineral", "other"] },
    Functions: { type: "array", items: { type: "string" } },
    Sources: { type: "array", items: { type: "string" } },
    RecommendedDailyIntake: { type: "string" },
    DeficiencySymptoms: { type: "array", items: { type: "string" } },
    ExcessSymptoms: { type: "array", items: { type: "string" } },
    TopFoodSources: { type: "array", items: { type: "string" } }, // New Field
    // **Note:** Removed system-generated fields (ItemID, DateAdded, NameLowercase)
  },
  required: ["ItemType", "Name"],
  additionalProperties: false,
};

// **Define the Storage Schema (Extends Input Schema)**
const storageSchema = {
  type: "object",
  properties: {
    ...inputSchema.properties,
    ItemID: { type: "string" },
    DateAdded: { type: "string", format: "date-time" },
    NameLowercase: { type: "string" },
  },
  required: ["ItemType", "Name", "ItemID", "DateAdded", "NameLowercase"],
  additionalProperties: false,
};

// **Compile the Schemas**
const validateInput = ajv.compile(inputSchema);
const validateStorage = ajv.compile(storageSchema);

// **Initialize AWS Clients**
const dynamoDBClient = new DynamoDBClient({});

// **Helper Functions**
const normalizeName = (name) => name.trim().toLowerCase();

const isConsumableIngredient = (itemData) => {
  if (itemData.ItemType !== "ingredient") return true;

  const category = itemData.Category || "";
  const nonConsumableCategories = [
    "poison",
    "chemical",
    "non-food",
    "cleaning agent",
    "toxic substance",
    "metal",
    "plastic",
    "drug",
    "medicine",
    "insecticide",
    "herbicide",
    "fungicide",
    "fertilizer",
    "petroleum",
    "non-edible",
    "radioactive",
    "synthetic compound",
    "material",
    "alloy",
    "paint",
    "solvent",
    "detergent",
    "adhesive",
    "lubricant",
    "pesticide",
    "disinfectant",
    "explosive",
    "gas",
    "element",
    "rock",
    "gemstone",
    "crystal",
    // Add other non-consumable categories if needed
  ];
  return !nonConsumableCategories.some((cat) =>
    category.toLowerCase().includes(cat)
  );
};

// **Cache Implementation**
const cache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

const getCachedResponse = (key) => {
  const cached = cache[key];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedResponse = (key, data) => {
  cache[key] = {
    data,
    timestamp: Date.now(),
  };
};

// **Handler Function**
export const handler = async (event, context) => {
  const correlationId = context.awsRequestId;
  console.log(`[${correlationId}] Received event: ${JSON.stringify(event)}`);

  try {
    const queryParams = event.queryStringParameters;
    const searchName = queryParams && queryParams.name;

    if (!searchName) {
      console.error(`[${correlationId}] Search name is required.`);
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({ error: "Search name is required." }),
      };
    }

    const normalizedSearchName = normalizeName(searchName);

    // Generate cache key
    const cacheKey = createHash("sha256")
      .update(normalizedSearchName)
      .digest("hex");
    const cachedData = getCachedResponse(cacheKey);

    if (cachedData) {
      console.log(`[${correlationId}] Returning cached data for: ${searchName}`);
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({ found: true, item: cachedData }),
      };
    }

    // Query DynamoDB for both ingredients and nutrients
    const queryCommand = new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "NameLowercaseIndex", // Ensure this GSI exists
      KeyConditionExpression: "#nameLowercase = :name",
      ExpressionAttributeNames: {
        "#nameLowercase": "NameLowercase",
      },
      ExpressionAttributeValues: marshall({
        ":name": normalizedSearchName,
      }),
    });

    const data = await dynamoDBClient.send(queryCommand);

    if (data.Items && data.Items.length > 0) {
      // Item found
      const itemData = unmarshall(data.Items[0]);
      setCachedResponse(cacheKey, itemData);
      console.log(`[${correlationId}] Item found in DynamoDB: ${searchName}`);
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({ found: true, item: itemData }),
      };
    } else {
      // Item not found, proceed to OpenAI
      console.log(
        `[${correlationId}] Item not found in DynamoDB, querying OpenAI: ${searchName}`
      );

      console.log(`[${correlationId}] Initiating OpenAI API call for: ${searchName}`);

      let openAIResponseContent;
      try {
        const OPENAI_TIMEOUT = 10000; // 10 seconds

        // Old SDK syntax for OpenAI
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini", // Ensure you're using the appropriate model
          messages: [
            {
              role: "system",
              content:
                "You are a helpful assistant that provides detailed information about consumable food ingredients. Your responses should be in valid JSON format without any additional text. Do not include fields like ItemID, DateAdded, or NameLowercase; these will be added by the system.",
            },
            {
              role: "user",
              content: `Determine if "${searchName}" is a consumable food ingredient or a nutrient (vitamin, mineral, etc.). Then, provide detailed information in **valid JSON format** according to the appropriate schema.
                
If it is an **ingredient**, use the following schema:
{
  "ItemType": "ingredient",
  "Name": {
    "English": "string",
    "Chinese": "string",
    "Spanish": "string"
  },
  "AlternateNames": ["string"],
  "Description": {
    "English": "string",
    "Chinese": "string",
    "Spanish": "string"
  },
  "YinYangClassification": "string", // Must be one of: "Yin (Cold)", "Yin (Cool)", "Neutral", "Yang (Warm)", "Yang (Hot)"
  "FiveElements": "string",
  "Category": "string",
  "FlavorProfile": ["string"],
  "MedicinalProperties": ["string"],
  "CommonCulinaryUses": ["string"],
  "OriginRegion": "string",
  "SeasonalAvailability": "string",
  "NutritionalInformation": {
    "ServingSize": "string",
    "Calories": "number",
    "Carbohydrates": "number",
    "Protein": "number",
    "Fat": "number",
    "Fiber": "number",
    "Vitamins": { "VitaminName": "amount as string with units" },
    "Minerals": { "MineralName": "amount as string with units" }
  },
  "AllergenInformation": "string",
  "PreparationTips": ["string"],
  "DietaryRestrictions": ["string"],
  "SubstituteIngredients": ["string"],
  "StorageMethods": {
    "ShortTerm": "string",
    "LongTerm": "string"
  },
  "CulinaryTechniques": ["string"],
  "CulturalSignificance": {
    "Region1": "string",
    "Region2": "string"
  },
  "HistoricalUsage": {
    "AncientTimes": "string",
    "ModernTimes": "string"
  },
  "EnvironmentalImpact": {
    "Positive": "string",
    "Negative": "string"
  },
  "TCMInformation": {
    "Functions": ["string"],
    "HerbalFormulations": ["string"],
    "Meridians": ["string"]
  }
}

Ensure that the "YinYangClassification" field is one of the following:
- "Yin (Cold)"
- "Yin (Cool)"
- "Neutral"
- "Yang (Warm)"
- "Yang (Hot)"

If it is a **nutrient**, use the following schema:
{
  "ItemType": "nutrient",
  "Name": "string",
  "Description": "string",
  "Type": "string", // Must be one of: "vitamin", "mineral", "other"
  "Functions": ["string"],
  "Sources": ["string"],
  "RecommendedDailyIntake": "string",
  "DeficiencySymptoms": ["string"],
  "ExcessSymptoms": ["string"],
  "TopFoodSources": ["string"] // List of top primary food sources
}

Ensure that the "Type" field is one of the following:
- "vitamin"
- "mineral"
- "other"

Ensure that:
- The entire response is a single JSON object.
- All keys and string values are enclosed in double quotes.
- All numerical values are numbers without units or additional text.
- Special characters (like newlines and tabs) are escaped.
- Do not include any explanations, apologies, or extraneous text; provide only the JSON.

If "${searchName}" is neither an ingredient nor a nutrient, respond with a JSON object like {"error": "Invalid item"} instead.`,
            },
          ],
          temperature: 0.7,
          max_tokens: 1500,
        });

        openAIResponseContent = completion.choices[0].message.content.trim();
        console.log(`[${correlationId}] OpenAI response received.`);
      } catch (openAIError) {
        console.error(`[${correlationId}] Error calling OpenAI API:`, openAIError);
        return {
          statusCode: 502,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          body: JSON.stringify({ error: "Failed to retrieve data from external service." }),
        };
      }

      // Check if OpenAI indicated that the item is invalid
      if (openAIResponseContent.toLowerCase().includes('"error":')) {
        console.error(
          `[${correlationId}] Invalid item according to OpenAI: ${searchName}`
        );
        return {
          statusCode: 404,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          body: JSON.stringify({
            error: `${searchName} is not a valid consumable food item or nutrient.`,
          }),
        };
      }

      // Attempt to parse JSON response
      let itemData;
      try {
        // Sanitize the response to extract JSON content
        const jsonStart = openAIResponseContent.indexOf("{");
        const jsonEnd = openAIResponseContent.lastIndexOf("}");
        if (jsonStart === -1 || jsonEnd === -1) {
          throw new Error("JSON object not found in OpenAI response");
        }
        const jsonString = openAIResponseContent.substring(jsonStart, jsonEnd + 1);

        itemData = JSON.parse(jsonString);
      } catch (parseError) {
        console.error(`[${correlationId}] Error parsing OpenAI response:`, parseError);
        console.error("OpenAI response content:", openAIResponseContent);
        return {
          statusCode: 500,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          body: JSON.stringify({ error: "Failed to parse data from external service." }),
        };
      }

      // **Validate the OpenAI Response Against the Input Schema**
      const validInput = validateInput(itemData);
      if (!validInput) {
        console.error(
          `[${correlationId}] OpenAI response does not match input schema:`,
          validateInput.errors
        );
        return {
          statusCode: 500,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          body: JSON.stringify({
            error: "Invalid data format received from external service.",
          }),
        };
      }

      // **Check if the item is consumable (for ingredients)**
      if (!isConsumableIngredient(itemData)) {
        console.error(`[${correlationId}] Item is not consumable: ${searchName}`);
        return {
          statusCode: 404,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          body: JSON.stringify({
            error: `${searchName} is not a valid consumable food item or nutrient.`,
          }),
        };
      }

      // **Assign System-Generated Fields**
      itemData.ItemID = randomUUID();
      itemData.DateAdded = new Date().toISOString();
      itemData.NameLowercase = normalizedSearchName;

      // **Validate the Complete Data Against the Storage Schema**
      const validStorage = validateStorage(itemData);
      if (!validStorage) {
        console.error(
          `[${correlationId}] Data with system fields does not match storage schema:`,
          validateStorage.errors
        );
        return {
          statusCode: 500,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          body: JSON.stringify({
            error: "Invalid data format after adding system fields.",
          }),
        };
      }

      // **Save the item to DynamoDB**
      const putItemCommand = new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall(itemData),
        ConditionExpression: "attribute_not_exists(ItemID)", // Prevent overwriting
      });

      try {
        await dynamoDBClient.send(putItemCommand);
        console.log(`[${correlationId}] Item saved to DynamoDB: ${searchName}`);
      } catch (dbError) {
        console.error(`[${correlationId}] Error saving item to DynamoDB:`, dbError);
        return {
          statusCode: 500,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          body: JSON.stringify({ error: "Failed to save item data." }),
        };
      }

      // **Cache the new item data**
      setCachedResponse(cacheKey, itemData);

      // **Return the newly added item**
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({ found: false, item: itemData }),
      };
    }
  } catch (error) {
    console.error(`[${correlationId}] Error processing search:`, error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
      },
      body: JSON.stringify({ error: "Internal server error." }),
    };
  }
};
