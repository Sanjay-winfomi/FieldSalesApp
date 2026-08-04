import React, { useEffect, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { registerAlertHandler } from '../services/themedAlert';
import { colors, typography, spacing, radius, shadows } from '../theme';

const DEFAULT_BUTTONS = [{ text: 'OK', style: 'default' }];

/**
 * ThemedAlertHost — mount once near the root (App.js). Registers itself with
 * themedAlert.js so any screen can call showAlert(title, message, buttons)
 * exactly like Alert.alert, but rendered with the app's own colors/typography
 * instead of the OS-native dialog.
 */
export default function ThemedAlertHost() {
  const [visible, setVisible] = useState(false);
  const [content, setContent] = useState({ title: '', message: '', buttons: DEFAULT_BUTTONS });

  useEffect(() => {
    registerAlertHandler((title, message, buttons) => {
      setContent({ title, message, buttons: buttons && buttons.length ? buttons : DEFAULT_BUTTONS });
      setVisible(true);
    });
    return () => registerAlertHandler(null);
  }, []);

  const handlePress = (button) => {
    setVisible(false);
    button.onPress?.();
  };

  const buttonTextStyle = (style) => {
    if (style === 'destructive') return { color: colors.danger };
    if (style === 'cancel') return { color: colors.textSecondary };
    return { color: colors.primary };
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {!!content.title && <Text style={styles.title}>{content.title}</Text>}
          {!!content.message && <Text style={styles.message}>{content.message}</Text>}

          <View style={content.buttons.length > 2 ? styles.buttonsStacked : styles.buttonsRow}>
            {content.buttons.map((button, index) => (
              <Pressable
                key={`${button.text}-${index}`}
                onPress={() => handlePress(button)}
                style={({ pressed }) => [
                  styles.button,
                  content.buttons.length <= 2 && styles.buttonFlex,
                  pressed && styles.buttonPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={button.text}
              >
                <Text style={[styles.buttonText, buttonTextStyle(button.style)]}>{button.text}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.xl,
    ...shadows.raised,
  },
  title: { ...typography.cardTitle, color: colors.text, marginBottom: spacing.sm },
  message: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.xl },
  buttonsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.lg,
  },
  buttonsStacked: {
    flexDirection: 'column',
    gap: spacing.xs,
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  buttonFlex: {
    flexGrow: 0,
  },
  buttonPressed: {
    backgroundColor: colors.neutralBg,
  },
  buttonText: { ...typography.button },
});
