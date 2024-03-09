type ProductSeatsMapping = {
  [productId: string]: number;
};

const productSeats: ProductSeatsMapping = {
  prod_PYxuYByQ6U1tCK: 1, // Free
  prod_PYxvepWcZa2v7K: 3, // Starter
  prod_PYxwITwNzYqxaJ: 5000, // Unlimited - seats are arbitrary, can be raised but unlikely to be hit
  prod_Pgqqt8hNokEwKb: 5000 // Enterprise - seats are arbitrary, can be raised but unlikely to be hit
};

export function getSeatsByProductId(productId: string | undefined): number {
  return productSeats[productId] || 0; // Returns 0 if product ID is not found
}

export function isEnterprise(productId: string): boolean {
  return productId === 'prod_Pgqqt8hNokEwKb';
}

export function getBillingPortalConfiguration(
  connectedChannels: number
): string | null {
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
