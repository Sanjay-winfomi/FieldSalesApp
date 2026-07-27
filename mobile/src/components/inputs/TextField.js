import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { colors, radius, typography, spacing } from '../../theme';

/**
 * Standard text input — rounded, left icon slot, focus/error border states,
 * optional right accessory (e.g. show/hide password).
 */
export default function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  icon,
  error,
  rightAccessory,
  secureTextEntry,
  autoCapitalize = 'sentences',
  keyboardType,
  style,
}) {
  const [focused, setFocused] = useState(false);

  const borderColor = error ? colors.danger : focused ? colors.primary : colors.border;

  return (
    <View style={style}>
      {!!label && <Text style={styles.label}>{label}</Text>}
      <View style={[styles.inputRow, { borderColor }]}>
        {icon}
        <TextInput
          style={[styles.input, icon && { marginLeft: spacing.sm }]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={secureTextEntry}
          autoCapitalize={autoCapitalize}
          keyboardType={keyboardType}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label || placeholder}
        />
        {rightAccessory}
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderWidth: 1.5,
    borderRadius: radius.input,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
  },
  input: {
    flex: 1,
    height: '100%',
    ...typography.body,
    color: colors.text,
  },
  error: {
    ...typography.caption,
    color: colors.danger,
    marginTop: spacing.xs,
  },
});
