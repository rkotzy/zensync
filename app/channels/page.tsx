import "@radix-ui/themes/styles.css";
import { getUser } from "../../auth";
import { Text, Heading, TextFieldInput, Flex, Box } from "@radix-ui/themes";

export default async function ChannelsPage() {
  const { user } = await getUser();

  const userFields = user && [
    ["First name", user.firstName],
    ["Last name", user.lastName],
    ["Email", user.email],
    ["Id", user.id],
  ];

  return (
    <>
      <Flex direction="column" gap="2" mb="7">
        <Heading size="8" align="center">
          Channels
        </Heading>
        <Text size="5" align="center" color="gray">
          Below are your channels
        </Text>
      </Flex>

      {userFields && (
        <Flex
          direction="column"
          gap="3"
          style={{ width: 400 }}
          justify="center"
        >
          {userFields.map(([label, value]) => (
            <Flex asChild align="center" gap="6" key={value}>
              <label>
                <Text weight="bold" size="3" style={{ width: 100 }}>
                  {label}
                </Text>

                <Box grow="1">
                  <TextFieldInput value={value || ""} readOnly />
                </Box>
              </label>
            </Flex>
          ))}
        </Flex>
      )}
    </>
  );
}