type ProductSeatsMapping = {
  [productId: string]: number;
};

const productSeats: ProductSeatsMapping = {
  prod_Q5BHjL3CLeZGhd: 1, // Free
  prod_Q5BHZhwI2uNlsF: 3, // Starter
  prod_Q5BHB0jQWtbY7z: 5000, // Unlimited - seats are arbitrary, can be raised but unlikely to be hit
  prod_Q5BHUnXfFOz93J: 5001 // Enterprise - seats are arbitrary, can be raised but unlikely to be hit
};

export function getChannelsByProductId(productId: string | undefined): number {
  return productSeats[productId] || 0; // Returns 0 if product ID is not found
}

export function isEnterprise(productId: string): boolean {
  return productId === 'prod_Q5BHUnXfFOz93J';
}

export function getBillingPortalConfiguration(
  connectedChannels: number
): string | null {
  return null;

  // We are not using the custom billing portal configurations
  // for now since they don't allow customer's to resubscribe
  // if they cancel a subscription. Because of this, we'll instead
  // let everybody be able to downgrade to the Free plan and block
  // cancellations.

  // If the customer has <=1 seats use the default portal
  if (connectedChannels <= 1) {
    return null;
  }
  // If the customer has 2-3 seats block Free downgrade
  else if (connectedChannels >= 2 && connectedChannels <= 3) {
    return 'bpc_1OrS3gDlJlwKmwDW0t9z87NQ';
  }
  // If the customer has > 3 seats block Starter and Free downgrade
  else if (connectedChannels > 3) {
    return 'bpc_1OrSVIDlJlwKmwDWWunkSSxd';
  }

  return null;
}
