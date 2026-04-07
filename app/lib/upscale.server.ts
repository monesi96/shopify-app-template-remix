import Replicate from "replicate";

const PRODUCTS_PER_PAGE = 50;

export async function loadProductsWithImages(admin: any, cursor: string | null, direction: string) {
  let query: string;

  if (cursor && direction === "next") {
    query = `#graphql
      query getProductsWithImages($cursor: String!) {
        products(first: ${PRODUCTS_PER_PAGE}, after: $cursor) {
          edges {
            cursor
            node {
              id title vendor
              media(first: 10) {
                edges {
                  node {
                    id
                    preview { image { url altText width height } }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }`;
  } else if (cursor && direction === "prev") {
    query = `#graphql
      query getProductsWithImages($cursor: String!) {
        products(last: ${PRODUCTS_PER_PAGE}, before: $cursor) {
          edges {
            cursor
            node {
              id title vendor
              media(first: 10) {
                edges {
                  node {
                    id
                    preview { image { url altText width height } }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }`;
  } else {
    query = `#graphql
      query getProductsWithImages {
        products(first: ${PRODUCTS_PER_PAGE}) {
          edges {
            cursor
            node {
              id title vendor
              media(first: 10) {
                edges {
                  node {
                    id
                    preview { image { url altText width height } }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }`;
  }

  const variables = cursor ? { cursor } : {};
  const response = await admin.graphql(query, { variables });
  const responseJson = await response.json();

  const countResp = await admin.graphql(`#graphql query { productsCount { count } }`);
  const countJson = await countResp.json();
  const totalProducts = countJson.data?.productsCount?.count || 0;

  const products = responseJson.data.products.edges.map((edge: any) => {
    const images = edge.node.media.edges
      .filter((m: any) => m.node.preview?.image?.url)
      .map((m: any) => ({
        mediaId: m.node.id,
        url: m.node.preview.image.url,
        alt: m.node.preview.image.altText || "",
        width: m.node.preview.image.width || 0,
        height: m.node.preview.image.height || 0,
      }));

    const minDimension = images.length > 0
      ? Math.min(...images.map((img: any) => Math.min(img.width, img.height)))
      : 0;

    return {
      id: edge.node.id,
      title: edge.node.title,
      vendor: edge.node.vendor,
      images,
      imageCount: images.length,
      minDimension,
      needsUpscale: minDimension > 0 && minDimension < 1000,
    };
  });

  return {
    products,
    pageInfo: responseJson.data.products.pageInfo,
    totalProducts,
  };
}

export async function upscaleImages(products: any[], scale: number) {
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });

  const results: any[] = [];

  for (const product of products) {
    const productResults: any[] = [];

    for (const img of product.images) {
      try {
        const output = await replicate.run(
          "nightmareai/real-esrgan:f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa",
          {
            input: {
              image: img.url,
              scale: scale,
              face_enhance: false,
            },
          }
        );

        const upscaledUrl = typeof output === "string" ? output : String(output);

        productResults.push({
          originalUrl: img.url,
          upscaledUrl,
          mediaId: img.mediaId,
          originalWidth: img.width,
          originalHeight: img.height,
          newWidth: img.width * scale,
          newHeight: img.height * scale,
          status: "success",
        });
      } catch (err: any) {
        productResults.push({
          originalUrl: img.url,
          mediaId: img.mediaId,
          status: "error",
          error: err.message,
        });
      }
    }

    results.push({
      productId: product.id,
      title: product.title,
      images: productResults,
    });
  }

  return results;
}

export async function replaceProductImage(admin: any, productId: string, oldMediaId: string, newImageUrl: string) {
  const createResp = await admin.graphql(
    `#graphql
    mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          ... on MediaImage {
            id
            image { url }
          }
        }
        mediaUserErrors { field message }
      }
    }`,
    {
      variables: {
        productId,
        media: [{
          originalSource: newImageUrl,
          mediaContentType: "IMAGE",
          alt: "Upscaled product image",
        }],
      },
    }
  );

  const createJson = await createResp.json();
  const errors = createJson.data?.productCreateMedia?.mediaUserErrors || [];
  if (errors.length > 0) {
    return { success: false, error: errors[0].message };
  }

  const deleteResp = await admin.graphql(
    `#graphql
    mutation deleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }`,
    { variables: { productId, mediaIds: [oldMediaId] } }
  );

  const deleteJson = await deleteResp.json();
  const deleteErrors = deleteJson.data?.productDeleteMedia?.mediaUserErrors || [];
  if (deleteErrors.length > 0) {
    return { success: true, warning: "Nuova immagine creata ma vecchia non eliminata: " + deleteErrors[0].message };
  }

  return { success: true };
}
